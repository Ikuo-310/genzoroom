# LightCraft Point Color 統合調査 P0

## 現行統合状態（2026-11-19）

本節以降のP0・段階記録は調査時点の記録であり、未実装・提案と記された過去の状態は現行仕様ではない。Windows LightCraft v0.20.0に対するPoint Color統合は、Backendのsnapshot validation、既存History API／SQLite保存、完全Recipe復元・Export設定伝搬、Frontend表示、Viewer採色、8項目編集、個別Reset、スウォッチ削除、配列全体Resetまで実装済みである。History operationは`pointColorPick`、`pointColorDelete`、`pointColorControl`、`pointColorControlReset`、`pointColorReset`を既存`/history/operate`経路で扱う。Point Colorの状態はNativeの順序付き`point_colors`配列で、個別永続IDは追加していない。

数値drag中はNative interactionの`begin → update → end/cancel`を使い、各update ACKを確認しながらDraft Previewを更新する。ドラッグ中の値はRecipe／Historyへ保存せず、Finish時に最後のACK値と`pointColorControl` metadataを一致させ、同じ確定snapshotを既存History／Recipe transactionへ保存する。Cancelはdraftをbaselineへ戻しHistoryを追加しない。保存結果不明時はSaverとimmutable save ID requestを保持し、同じrequestのretryまたはreceipt replayへ進む。未確定Historyがあるworkspaceを明示discardしない。

Document離脱では`RawWorkspaceTermination`がhook寿命から独立してworkspace ID、Saver、終了段階、進行中Promiseを保持する。保存settleは共有queue外、releaseと次Document openは既存queueで順序付ける。明示discardは既存のinteraction/drain ownership規則を維持し、Point Colorのsettle完了後に終了処理へ進む。保存結果不明（`unknown/saving`）はBackend empty照会で解消しない。Backend終了結果不明（`unknown/releasing`）はownerが保持する旧IDに対する状態照会と、安全性を満たす場合の同じID再試行で解消する。Backend終了確認後の後始末失敗（`unknown/completing`）はBackend操作を再送せず後始末だけを再試行する。旧Saver／Editor、通信状態、Preview URLの後始末が完了してから後続openを許可する。

F1〜F19の監査修正は本書末尾の「最終監査修正 F12〜F19」に追記した。通常操作のWindows Desktopユーザー確認では、使用した範囲で問題がなかったとの報告を受けている。通信断など全異常系を実機で再現したわけではなく、多くはMock Native／Frontend自動テストによる確認である。Backend create応答が失われworkspace ID自体を得られない場合はFrontendだけではworkspaceを特定できず、保存結果が不明な場合は終了と後続openを安全側に保留することがある。

**Point Color「範囲を表示」はP1-A〜P2-Bで実装済み。** LightCraft v0.20.0既存の`Overlay::PointColorRange(index)`をHeadless／MCPのWhole・Region描画契約へ公開し、GenzoRoom BackendとFrontendから選択中の範囲を一時表示する。Native契約番号は`pointColorRangeContract: 1`。古いP0節の未実装・提案記述は当時の記録であり、現行仕様は本書末尾の「Point Color Range実装記録」を参照する。

## 1. 調査対象バージョン・固定 Commit

- GenzoRoom の基準は `main` の `2874ebda76506d7191a88fb2efc8e211619bc312`。調査開始時の作業ツリーは clean で、ローカルの `origin/main` と一致。
- [manifest](../../../native/lightcraft/manifest.json) の LightCraft は v0.20.0、固定 SHA は `192ff72923c39e6623f2c7ff67ab3a119deb8071`（`Release 0.20.0`）。以下の Native ソース参照は `.tmp/lightcraft-0.20.0-p3` のこの checkout relative。
- 当時のP0調査時点ではPoint Color Overlay公開契約は未実装だった。正式managed patchの現行SHA-256およびOverlay追加内容は、本書末尾の「Point Color Range実装記録」に記録する。
- 実行した既存 `target-p3-wb/release/lightcraft-cli.exe` の SHA-256 `30fa30913ceca0f3083ea05d0ebce27fb5668c00b1e78f9d6c2365e43686aa04`、隣接 receipt の tuple・契約番号と実測 SHA を照合した。MCP handshake も v0.20.0。

「ソース確認」はこの固定版の記述、「実 CLI」は §13 の隔離 probe、「提案」は P1 以降の設計判断を指す。

## 2. Desktop UI の観察仕様

**ユーザー観察**。未採色時はスポイトと案内のみ。採色後は複数の色スウォッチ、選択色の調整、選択色の削除と「範囲を表示」が現れる。Hue／Saturation／Luminance／観察時の「ぼかし」は 0、全体と各軸の範囲は 50。青空とバイクの青がカラーで残り、その他がモノクロになった。

**ソース確認**。Edit パネルの Color 内 flyout が `panels/edit/mixer.rs::point_color` を呼ぶ。空なら案内を表示して return。8 件に達するとスポイトが無効になる。選択 index の輪郭を描画し、スウォッチは `oklch_color` で採色値を OkLCh → linear Rec.2020 → sRGB へ変換し gamut を丸める。固定版の第4スライダーは英語 `Variance`、`locales/ja.json` の訳は「ばらつき」。範囲境界を調整する Feather の項目は見つからなかった。観察時のラベル表記差は実機未照合。

## 3. Native Point Color データモデル

`DevelopSettings.point_colors: Vec<PointColor>` が写真ごとの順序付き可変長配列を保持する。全 11 フィールドは Rust `f64`。色の中心は `lum`（OkLab L、0–1）、`chroma`（OkLCh C、ソース注記は 0–約 0.37）、`hue`（OkLCh h、採色結果は度で 0 以上 360 未満）。残る 8 値は §5。元画像座標やスウォッチの RGB は保存しない。ID はなく、0 始まり index が Native コマンドの対象。挿入は末尾、削除は `Vec::remove` で後続が詰まる。重複色は独立して追加できる。

`MAX_POINT_COLORS = 8` は Desktop 採色、`pointColor.pick`、通常描画時の先頭 8 件への制限。serde の配列自体に上限はなく、実 CLI でも `develop.merge` で 9 件を保持できた。GenzoRoom の操作と保存の境界で最大 8 件を扱う。既存の長い明示配列を開く場合の扱いは P1 で決め、黙って後続を削除することは避ける。

`DevelopSettings` と `PointColor` は `#[serde(default)]`。全体欠落から完全デシリアライズすれば `point_colors = []`。個々の欠落フィールドも struct の既定値（中心 L=0.5、C=0.1、h=0、調整数値は §5）になる。通常の新規採色では中心を Native 測定値で上書きする。選択 index と範囲表示は Desktop の `UiState`、初期値は 0 / false。写真設定・Recipe・履歴に入るのは配列。削除後、Desktop は同じ数値 index の次の要素に移り、末尾削除なら次回描画で残る末尾へ補正。空なら選択欄と範囲表示欄を描画しない。

## 4. 採色・エントリー管理 API

| 操作 | v0.20.0 Native 契約 |
| --- | --- |
| 採色と追加 | `pointColor.pick {x,y}`。active photo を対象に同期サンプルを追加し、`{index,lum,chroma,hue}` を返す。調整初期値はこの応答に含まれない。 |
| 削除 | `pointColor.delete {index}`。非負整数を受ける（整数相当の JSON float も許容）。成功は Engine の `null`、実 MCP は text `ok`。 |
| 完全取得 | `develop.get {id?}` または MCP `get_develop`。配列全体を含む設定 snapshot。 |
| 一括復元・全削除 | `develop.merge {settings, label?}`。JSON object を再帰 merge、配列は丸ごと置換。`{"settings":{"point_colors":[]}}` で全削除。キーの省略は現値を維持する。 |
| 個別調整 | `develop.set {control,value}` または `{values:{…}}` と `develop.resetControl {control}`。§5 の index 付き ID を使用。 |

**公開経路**。Desktop の `app.run` と Headless の `Session::execute` が同じ Engine commands を使う。CLI の `lightcraft-cli mcp --headless --compact` で `list_commands` と `command_run {id,params}` を確認。MCP には `run_command {command,params}` と設定用 helper もある。座標なしの独立採色コマンドや選択切替コマンドは不要。色中心を既知の JSON から入れる場合は配列 merge が契約。

**座標と画素**。Desktop の `general_interaction` は写真クリックを `CanvasMap::norm`（`Frame::out_to_norm`）へ渡す。x/y はユーザー Rotate/Flip 適用後の oriented grid 上、crop 適用前に相当する正規化座標で、レンズ・透視補正の逆 warp を行うマスク専用座標とは異なる。RAW のカメラ orientation と非RAWの EXIF orientation は `files/load.rs::load_bytes_now` でソースに反映済み。Native Frame はそこへ `DevelopSettings.orientation` とレンズ／透視補正を適用し、crop rect・straighten・crop の `flip_h/flip_v` を出力変換に織り込む。

`cmd/color.rs::probe` は `source_now(id, SourceLevel::Thumb)` から CPU で長辺最大 384px の fit proxy を作る。現在設定を複製し `after_mixer_neutral` で Point Color 全件、vibrance、saturation、grading、vignette、grain、curve を中立化し、Treatment を Color にする。Mixer やその前の現像、幾何は保持する。採色画素はこの現像済み 8-bit sRGB proxy 上の値で、元のセンサー値や画面の最終 RGB と異なる。x/y を各 0–1 に clamp → proxy の `Frame::norm_to_out` → floor → 近傍 3×3 の sRGB 符号値を平均（端では端画素を反復）→ sRGB 線形化 → Rec.2020 → OkLCh。Original や可視化済み PNG を採色する経路は通らない。

**確定・失敗・所有権**。スポイト起動・hover は UI 状態。Desktop はクリック送信で追加を確定し、応答が成功なら返った index を選択し、成功・失敗ともスポイトを解除。送信前の解除で settings は変わらない。送信成功後は Native の `set_develop` による 1 編集で、取消は Undo。数値欠落／型違い・9件目・存在しない削除 index はエラー。active photo がないと command の有効条件に阻まれ、ソース取得失敗は `bad` に包まれる。範囲外の数値座標は clamp される（実 CLI で x=3 を確認）。コマンドに写真 ID・リビジョンはなく、同期で active photo を更新する。Native `set_develop` は既に開始済みの一般 Interaction に参加し得るため、GenzoRoom は既存の document lease・Native command queue・generation/revision と active owner を利用し、Curve／Mixer 操作や切替中からの混入を防ぐ。既存 `_raw_command` の allowlist には pick/delete の追加が必要。

**GenzoRoom 座標の再利用判断**。Whole 画像上の表示点から `ImageViewer` と `rawTargetCoordinates.ts::{rawTargetPoint,rawTargetOrientedSize}` を使う方針。ユーザー orientation は軸交換後の寸法で扱い、補正を二重適用しない。zoom/pan/Region 上の点は Whole 出力へ戻してから変換し、geometry/viewGeneration の一致した After を使う。Crop 編集中は通常の採色を解除し、bounded crop・straighten と実 EXIF を含む位置一致は P1 で確認する。WB・Curve・Mixer と座標・ツール排他・ルーペを共有できるが、WB managed candidate は読取り専用＋明示 identity、Curve／Mixer はドラッグ中の差分更新。Point Color はクリックで可変配列へ追加する。範囲表示中はルーペが診断画素を示しつつ採色は proxy を使うため、採色開始時は通常 After に戻す案とする。

## 5. 8 種類の調整コントロール

共通で `f64`、Desktop step 1、表示小数 0 桁。UI は spec の値をそのまま使い、別のスケール換算はしない。Native の `controls::set` は clamp するが 1 刻みに丸めず、実 CLI で -12.5 を保持した。接頭辞は `pointColor.<index>.`。

| UI / spec | ID の末尾 | snapshot フィールド | 範囲 / 既定 | 描画上の意味 |
| --- | --- | --- | --- | --- |
| Hue | `hueShift` | `hue_shift` | -100…100 / 0 | 正で OkLCh hue 角が増加、負で減少。±100 は weight=1 で ±0.5 rad（約 ±28.65°、Variance 寄与を除く）。 |
| Saturation | `satShift` | `sat_shift` | -100…100 / 0 | chroma を `max(0, C × (1+w×v/100))` で調整（C は Variance 適用後）。 |
| Luminance | `lumShift` | `lum_shift` | -100…100 / 0 | OkLab L に `w×0.2×v/100` を加算。 |
| Variance（ばらつき） | `variance` | `variance` | -100…100 / 0 | 中心との差（h は wrap）を `w×0.8×v/100` 倍して h/C/L へ加算。負は圧縮、正は拡張。境界のぼかし幅は変えない。 |
| Range | `range` | `range` | 0…100 / 50 | 3 軸の半幅に共通の `k = max(range/50,0.05)` を掛ける。0 でも幅を残す。 |
| Hue Range | `hueRange` | `hue_range` | 0…100 / 50 | 色相半幅 `(0.1 + 0.6×v/100)×k` rad。 |
| Saturation Range | `satRange` | `sat_range` | 0…100 / 50 | chroma 半幅 `(0.02 + 0.12×v/100)×k`。 |
| Luminance Range | `lumRange` | `lum_range` | 0…100 / 50 | lightness 半幅 `(0.05 + 0.4×v/100)×k`。 |

`develop.controls {section:"pointColor"}` は存在中の要素だけを展開し、spec と現在値を返す（0 件なら空、7 件で 56 項目を実確認）。テンプレートに合う存在しない index は `develop.set` が成功表示のまま更新しないことを確認した。未知の ID は拒否。個別 Reset は上表の既定値。汎用 `develop.resetSection` は固定 control の列挙しか見ないため `section:"pointColor"` が成功しても配列・値とも保持された。JSON merge は型を serde で検査するが `keep_in_range` が固定 control のみ走査するため、indexed slider の clamp や 8 件制限を保証しない（125 と 9 件が readback に残った）。描画時 `PointK::new` は調整値と範囲を再 clamp する。

Native プロトコルが毎回完全 readback を要求するわけではない。GenzoRoom の確定保存では既存の `develop.get` を使い、追加・削除による配列形状と clamp 済みの値を Native の snapshot から得る。存在 index の事前照合と操作対象の結果確認で成功扱いの no-op を識別する。ドラッグ中は既存数値操作の集約と最終 flush を候補とし、ポインターイベントごとに新たな完全比較を加える必要はない。

Desktop の `apply_slider_out` はドラッグを `develop.beginInteraction` → `develop.set` の連続更新 → `develop.endInteraction` で 1 Undo にまとめる。Engine には開始状態へ戻す `develop.cancelInteraction` もある。スポイトの 1 クリックとは別の操作境界。

## 6. 範囲可視化の内部処理

**通常現像**。CPU は `pipeline/colorops.rs::ColorOps::{new,apply}`、GPU は `gpu/src/wgsl/finish.wgsl::point_color` と Finish の色処理。Mixer 後に先頭 8 件のうち非中立のエントリーを配列順に適用し、続けて vibrance、saturation、Grading 等を処理する。後続エントリーは先行エントリーが変更した色で weight を計算するため、重なりでは順序に依存する。B&W Treatment／mono profile では通常描画の Point Color をスキップする。

`PointK::weight` は中心からの OkLCh 距離を軸別に評価する。各半幅の内側 1/2 から外周にかけて smoothstep で 1→0、軸の重みの積で連続値 w を得る。色相は円周の最短差。中心 chroma <0.02 のとき hue を無視し、chromatic な中心では pixel chroma 0.005–0.025 の smoothstep で無彩色の寄与を抑える。GPU の通常現像はこの方式を WGSL で実装する。

**Desktop Overlay の呼出順**。

1. `panels/detail.rs::view_overlay` が Edit、Point Color flyout open、`UiState.point_color_visualize`、有効な選択 index により `Overlay::PointColorRange(index as u8)` を返す。fullscreen は None。Alt-drag の診断等が優先する条件もある。
2. `request_main` が `loupe_job(...).with_overlay(overlay)` を作る。操作中 Draft、静止時 Full。zoom では `detail/window.rs` の `overlay_supports_window` が PointColorRange を許可し、After の `region_job` に同じ Overlay を渡す。Before の Region tile は None。Whole の Before は別ジョブ。
3. `engine/media/render.rs::RenderJob::with_overlay` が結果 key にモード/index を反映し、診断描画の通常 view cache への保存を無効化。`pipeline::plan` → `visualize::adjust_settings` は描画用コピーで選択エントリーの `hue_shift/sat_shift/lum_shift/variance` のみゼロにする。中心と範囲、他のエントリー、後段の通常設定は残る。
4. CPU の `pipeline/src/lib.rs` は通常の 8-bit 出力へ `visualize::apply`。GPU の `gpu/src/render.rs` も画素 readback 後に同じ CPU 関数を呼ぶ。Overlay 付きは GPU の直接 texture 表示条件から外れるが、8-bit の GPU 現像経路は使える。GPU 可否と Overlay の計算場所は別。
5. `visualize::point_color_range` は描画後の RGB を sRGB として線形化し、Rec.2020 経由の OkLCh で選択エントリーの `PointK::weight` を再評価。同じピクセルの符号値から `grey = .2126 R + .7152 G + .0722 B` を計算し、各 RGB を `round(grey + (channel-grey)×w)` にする。w=0 はグレー、w=1 は元の色、境界は部分脱彩度。Overlay は選択 1 エントリー。

**重要な契約差**。通常描画と Overlay は範囲パラメータと重み関数を共有するが、通常は Point Color 段の画素、Overlay は選択エントリーだけを中立化した最終 8-bit 画素を判定する。Grading、他エントリー、カーブ等が強いと通常調整の影響範囲と一致しない。Desktop と同じ挙動を得るにはこの既存 Overlay を公開する。UI 側で RGB 判定やグレーへの後処理を実装する方式は採用しない。

## 7. Headless API 公開状況 — B

RenderJob／CPU/GPU 描画機能は共通コードに存在し、CLI/MCP の公開引数には到達経路がない。実 `tools/list` の Whole は `id, max_side, format, include_frame, crop_edit, before, quality`、Region は `id, operation, region_contract, target`。ソースで `render_preview` → `render_photo` → Headless `ui.render` の引数転送、`render_region_preview` → `ui.region` の schema/handler を照合した。Whole/Region とも `with_overlay` の呼出なし。`develop.preview` という公開 Engine command はこの checkout に見当たらず、Desktop の診断指示も一般 command にはない。UI 接続時の `control.rs::ui.render` も `render_now` で、Desktop canvas の状態を継承しない。Overlay の内部 enum/コード化は MCP 引数の契約を構成しない。

**提案する最小 patch**。Whole の `crates/mcp/src/tools.rs` で選択 index を受ける Preview 専用の任意引数を schema・forwarding に追加。`crates/mcp/src/headless.rs` の `ui.render` で実設定の有効 index（0–7 かつ配列内）、After、Color 有効などの適用条件を検査し、既存 `RenderJob::with_overlay(Overlay::PointColorRange(...))` を呼ぶ。診断結果を通常 After と区別できる metadata を応答で返す。引数名と metadata は P2 の契約設計で確定する。対応 binary の schema／実応答を確認し、managed patch・manifest／receipt をその段階で更新する。採色、調整、削除、通常 Preview、Export のための Native patch は不要。

**適用範囲**。Whole の Draft/Full とも既存 job の品質切替を利用できる。crop の適用は Frame の責務で、通常 cropped preview と Overlay は共存可能。GenzoRoom の crop-edit と Before は編集補助として排他にする。Native 内部では `tests_window.rs` に Point Color Overlay の window/whole 比較があり、Desktop zoom も window を使用。現 managed Region MCP は未公開なので、P2 の初期版では表示中だけ Whole を zoom/pan する。高倍率での画質が必要なら同じ Overlay を `ui.region` と Region schema/response へ配線する。Region plan は色で幾何が変わらなくても、render の採用 identity にはモード/index を含める。CPU/DX12 の実可視化と window 境界は公開後に確認する。

## 8. Preview／Export の分離

**ソース確認**。Desktop の checkbox と選択 index は `UiState` のみ。フラグは `DevelopSettings` に存在せず、Overlay は `RenderRequest` の一回限りの値で Native Session の写真設定や History に保持されない。通常 Whole/Region、Before、Export の job は Overlay を指定しない。Export は `export_job` と保存済み調整設定を使い JPEG を描画する。診断向けにゼロ化した値を書き戻さない。Desktop ソース上、写真切替や履歴移動で checkbox/index を明示的に初期化する代入は見つからなかった。空・範囲外、flyout 閉、Edit 外、Before 等で診断画像の表示を抑える条件がある。

**提案**。GenzoRoom は写真単位の選択 index と checkbox を `useRawDocument` 周辺の UI 状態で所有する。Undo/Redo/Jump では表示を解除し、復元後の有効範囲に選択を合わせる。写真切替・パネル閉・Color OFF・Before・Crop 編集・選択可能なリストが空になった場合も解除する。選択や checkbox を切り替えた場合は settings revision が同じでも viewGeneration/要求 identity を変え、古い診断 PNG を通常 After や別 index に採用しない。スライダー変更は通常の編集リビジョンで Draft → Full を再要求し、範囲軸の更新を反映する。選択中の調整 4 値は診断描画で中立化されるので、診断中にそのスライダーを動かしても直ちにカラールックが変わらない場合がある。Before のリクエスト、通常の thumbnail、Recipe/History、JPEG Export には診断 identity を渡さない。

## 9. History／Recipe 統合（P0時点の課題と後続実装）

以下の確認・候補箇所はP0時点の設計記録である。Point ColorのHistory API、Store metadata、完全snapshot復元と旧snapshot補完は後続P1-A2/P1-A2c-3bで実装済みであり、未解決の現行課題として読むものではない。

[Backend](../../../backend/windows_raw_api.py) が History の readback と永続化を所有し、[Recipe store](../../../backend/raw_recipe_store.py) は未公開フィールドを含む Native JSON を保持して各 step の完全 snapshot を保存する。Undo/Redo/Jump は保存 snapshot を復元するので、index の再実行や各 step での Native `edit.undo` に依存する必要はない。現行 `_restore` は Native reset → `develop.merge` → readback 比較。[raw_controls.py](../../../backend/raw_controls.py) に完全復元／比較用の既定値補完がある。旧 snapshot の欠落を `[]` に正規化する候補箇所はここ。欠落のまま partial merge すると現在値が残り得るうえ、空配列付き readback と比較不一致になる。旧保存値・fingerprint・receipt は開いた時点で書き換えず、復元ペイロードと比較用の値にだけ既定を補う。Explicit malformed とキー省略は区別する。

| 操作 | P1-A2（Backend History operation 統合）の境界案 |
| --- | --- |
| 採色追加 | 完了したクリック 1 回につき `operate` 系の確定 1 件。Native readback による配列を保存。active source・frame・revision が変わっていた場合は送信を抑止する。保存失敗時は既存の immutable retry／recovery を利用し、採色を再送して重複を増やさない。 |
| 選択・範囲表示 | UI 状態。History 件数、Recipe revision を増やさない。 |
| 8 スライダー／個別 Reset | 集約した 1 編集または 1 Reset を既存 control／controlReset の操作境界へ対応。現行固定 ID 列挙と control location は可変 index を扱わないため、有効 index の照合と型の拡張を検討。 |
| 個別削除 | 明示操作 1 回で `operate` 系の確定 1 件。配列全体の snapshot で復元し、選択は残る同じ index か末尾へ寄せる。 |
| Point Color 全体 Reset | `point_colors: []` の merge をサブカテゴリ Reset 1 件へ対応。空なら意味上の no-op。Native `resetSection(pointColor)` の成功表示に依存しない。 |
| Undo/Redo/Jump、再オープン | 完全 snapshot で順序・重複・調整数値を復元。現在選択・診断は §8 の UI 初期化で扱う。 |
| JPEG Export | 保存確定済み snapshot を独立 Native Session に復元し、既存の出力を利用。 |

既存の metadata は whitelist で、追加や削除を意味する既存 kind はない。旧 kind に別の設定操作として載せると履歴の説明と検証がずれる。P1 で snapshot/adaptor 検証後に必要な operation metadata・ラベルを確定する。エントリーの識別に永続 ID や SQLite schema を増やす根拠は現時点でない。History step の ID と Point Color の配列 index は用途が異なる。操作の再試行、Revision の衝突、途中 readback 失敗、写真切替は [rawRecipeSave](../../../frontend/src/rawRecipeSave.ts) と [LightCraftRawSession](../../../backend/lightcraft_raw.py) の既存経路へ載せる。

## 10. GenzoRoom UI統合（P0時点の方針と現行実装）

以下の「提案」は実装前のP0記録である。現在はPoint Colorの表示、Viewer採色、8項目編集、Reset、削除に加え、「範囲を表示」も既存Frontend／History・Preview経路へ接続済みである。P0時点との差分は先頭および本書末尾の現行状態節を参照すること。

**提案**。[RawAdjustmentControls](../../../frontend/src/RawAdjustmentControls.tsx) の Color 内で Mixer／Grading と同じ折りたたみ・Reset・ロックの形を再利用。空ではスポイトと採色案内、採色後に最大 8 スウォッチ、8 個のスライダー、選択色の削除、独立した範囲表示のチェック項目を置く。幅が狭い場合にスウォッチを折り返し、入力行は内容に応じて伸縮させる。Point Color 独立 ON/OFF は設けない。Undo/Redo や写真切替時の index と checkbox は写真編集 UI で管理し、`appSettings.ts` に保存する場合も flyout の開閉設定だけを対象とする。

Viewer の crosshair と [ViewerPointLoupe](../../../frontend/src/ViewerPointLoupe.tsx) を WB と同じクリック型で再利用し、Curve/Mixer ターゲットとの排他、Space-pan、Escape、pointer/keyboard の既存ガードを利用。選択はキーボードでも移動可能にし、スウォッチには番号と選択状態を付ける。UI は未採色、最大数、送信中／保存中、失敗、画像未確定を既存の表示に合わせて扱う。スウォッチの色表示は表示用 OkLCh 変換に限る。

## 11. RAW／非RAW 互換性

- **Windows**。RAW とサポート対象の非RAWはともに LightCraft Native `open_raw`／`render_preview`／Export の経路を共有する。Native pick は両方の `SourceLevel::Thumb` を利用し RAW 専用 guard がない。CPU 合成 PNG は実確認、実 RAW は既存の `engine/src/tests/color.rs` 等のソース確認と設計判断にとどまる。
- **Color ON/OFF**。`DevelopSettings::effective` は Color OFF の描画コピーから Point Color 配列を除く。元設定は保持し、ON で再描画される。Native B&W Treatment／mono profile でも通常 Point Color は無効。GenzoRoom では無効時の採色と範囲表示を抑える。採色コマンド単体に Color ON/B&W の guard を期待しない。
- **親／兄弟 Reset**。Native `resetSection(color)` は WB・Color の固定 control を初期化する。現行 GenzoRoom 親 Color Reset も Mixer を保持し、Point Color を導入しても配列を保持する案。Mixer Reset は HSL band、Grading Reset は現行公開値だけを対象にし、両方とも配列を保持する。Native プリセットの `SettingsGroup::ColorMixer` は `mixer,bw_mix,point_colors` を含む別の契約。Point Color の明示的な全体 Reset は §9 の配列クリア。
- **Legacy／Export**。欠落キーは `[]` として復元・比較し、既存 snapshot はそのまま保存。Windows Export Queue は [export_runtime.py](../../../backend/export_runtime.py) と [raw_export_artifact.py](../../../backend/raw_export_artifact.py) で保存済み設定を isolated Native process に渡し、merge 後・出力後の readback を比較する。この比較にも同じ既定化が必要。JPEG には通常現像の Point Color の効果が載る。診断 PNG は別の要求。
- **Docker**。[jpeg_renderer.py](../../../backend/jpeg_renderer.py) と JPEG 用 Recipe/History は別経路で、この統合の対象外。Point Color の設定キー、マスク処理、表示項目を JPEG 側へ追加する必要はない。

## 12. 採用可能な実装方式

1. **既存 Native コマンド＋完全 snapshot**。採色、削除、数値編集、配列 Reset、通常 Preview、Recipe/History/Export を同じ開発設定に接続できる。混在操作の許可条件と保存失敗後の再試行は既存 GenzoRoom の所有権で管理。
2. **P0時点の歴史的な提案**。Preview 専用の最小 Native 公開 patchでDesktopと共通の`RenderJob::with_overlay`をHeadless Wholeへ公開する案を検討した。この提案はP1-A／P1-Bで実装され、現在の公開契約は本書末尾に記録している。
3. **成立しない経路**。既存 `render_preview` の設定変更だけで同じ表示を得る方法は確認できなかった。通常 After を単純にモノクロにする方法や、全調整を書き換えて疑似表示する方法では、Desktop の選択エントリーのみを中立化して最終色から重みを再計算する処理を再現できず、永続化の境界も崩れる。

## 13. P0時点の実確認・未解決事項（後続工程で一部解消）

**実 CLI 確認**。SHA/receipt 照合済み CLI、CPU（`LIGHTCRAFT_GPU_BACKEND=off`）、一時ディレクトリ内の合成 64×32 二色 PNG と in-memory Headless Session を使用。MCP schema と command list、空 snapshot/controls、採色値と初期値、重複採色、座標 clamp、不正座標、8 件上限、削除と index 移動、0/56 control 列挙、存在しない index の書込み no-op、clamp／小数保持、個別 Reset、Point Color Section Reset の no-op、キー省略と空配列 merge、配列 merge が 9 件・範囲外値を保持することを確認。通常 Draft/Full PNG を取得し、Full が編集前と異なること、合成素材の JPEG 出力と前後 snapshot の Point Color 一致を確認。JPEG の画素別照合は実施していない。

**P0調査時点で未確認**。実 RAW/非RAW と EXIF・Rotate/Flip・Straighten・Crop・高倍率 Region の組合せにおける採色位置、proxy とルーペの色差、RAW の埋込 Preview/フォールバック時の採色、Desktop 範囲表示の目視と翻訳ラベル表記、DX12 と CPU の診断出力/応答性、GenzoRoom アプリでの History/Recipe/Legacy/JPEG Export を実測していなかった。後続工程で自動テスト、実Native合成JPEG／DNG正常系、およびユーザーによる通常Desktop操作確認を追加したが、通信断等の全異常系を実機確認した意味ではない。範囲表示を既存 Headless に仮の引数で呼び出す試験は行っていない。

**P0時点でのリスク候補**。配列indexは移動・再利用されるため、古い要求が別色に作用しないよう後続実装ではrevisionと操作所有者で検証する。明示配列の不正型・長さ、旧snapshot省略、保存再試行、Color OFF/B&W、診断PNGの取り違えは後続P1 focused tests／実装で扱った。強いGrading等によりDesktop診断と通常調整の範囲が異なる点はLightCraft v0.20.0の挙動であり、GenzoRoom独自の画像処理では解消しない。

## 14. P1 以降の段階的実装案

この段階表はP0調査時点の提案であり、現行ロードマップではない。**Point Color編集・保存・Export設定引き渡し・Frontend操作・範囲表示はP1-A〜P2-Bで実装済み**。現在の確定契約・実装経路・検証状況は本書末尾の実装記録を参照し、P0時のpatch候補を将来作業として扱わない。

## 15. 主要ソース

| 領域 | 固定版 LightCraft ソース・シンボル |
| --- | --- |
| 設定／復元 | `crates/develop/src/settings.rs`（`DevelopSettings`, `PointColor`, `MAX_POINT_COLORS`）、`lib.rs`（`merged`, `keep_in_range`, `effective`, `reset_section`）、`presets.rs`（`deep_merge`, `SettingsGroup`） |
| コマンド／履歴 | `crates/engine/src/cmd/{color,query,develop,edit}.rs`（`probe`, `pointColor.pick/delete`, `develop.get/controls/set/merge/resetControl/resetSection`）、`crates/develop/src/controls.rs`（`INDEXED`, `indexed_instances`）、`crates/engine/src/lib.rs`（`set_develop`, Interaction） |
| Desktop | `crates/ui-egui/src/panels/edit/{mixer,sliders}.rs`、`panels/detail.rs`（`view_overlay`, `request_main`, `general_interaction`）、`panels/detail/{geometry,window}.rs`、`state.rs`、`locales/ja.json` |
| 画素／描画 | `crates/engine/src/files/load.rs`（`load_bytes_now`）、`crates/pipeline/src/geometry.rs`（`Frame`）、`colorops.rs`（`PointK/ColorOps`）、`visualize.rs`（`Overlay`, `point_color_range`）、`lib.rs`（`plan`）、`crates/gpu/src/{render.rs,wgsl/finish.wgsl}` |
| Preview／Export | `crates/engine/src/media/{render,session}.rs`（`with_overlay`, `export_job`）、`crates/mcp/src/{tools,headless}.rs`、`apps/lightcraft-cli/src/main.rs` |
| 関連検証ソース | `crates/engine/src/tests/color.rs`、`crates/develop/src/controls.rs`、`crates/pipeline/src/{colorops,visualize,tests_window}.rs`、`crates/gpu/tests/it/equivalence.rs` |

GenzoRoom 側の既存設計は [Color Mixer 調査](COLOR_MIXER_INTEGRATION.md)、[WB Native 契約](WB_NATIVE_CONTRACT.md)、[Region 設計](RAW_REGION_PREVIEW_DESIGN.md) を参照。接続箇所は [Native runtime](../../../backend/lightcraft_runtime.py)、[Windows API](../../../backend/windows_raw_api.py)、[Recipe store](../../../backend/raw_recipe_store.py)、[rawApi](../../../frontend/src/rawApi.ts)、[useRawDocument](../../../frontend/src/useRawDocument.ts)、[ImageViewer](../../../frontend/src/ImageViewer.tsx)、[rawTargetCoordinates](../../../frontend/src/rawTargetCoordinates.ts)。

## P1-A0 — Backend mutation と保存境界の調査

**調査範囲**。現在の `main` `cd6d165` の [lightcraft_raw.py](../../../backend/lightcraft_raw.py)、[windows_raw_api.py](../../../backend/windows_raw_api.py)、[raw_controls.py](../../../backend/raw_controls.py)、[raw_recipe_store.py](../../../backend/raw_recipe_store.py)、[lightcraft_runtime.py](../../../backend/lightcraft_runtime.py) を確認した。Native command は呼び出しておらず、製品コード、テスト、Recipe／History／DB は変更していない。

### 既存の mutation と History 保存経路

通常スライダーは Windows API `/documents/{handle}/controls` のみで適用する。`_execute` が workspace/documentToken/generation/expectedRevision と History 状態を検査し、History が初期化済みなら `_history_enabled` が false の直接編集を `raw_history_client_required` で拒否する。初期化前だけ `validate_controls` → `LightCraftRawSession.set_controls` → `_mutate` → Native `develop.set`／`develop.merge` → `develop.get` → `_commit` が通る。この経路は操作後 snapshot を即座に返すが History append は行わない。通常利用では先に History を初期化し、以後の編集を History endpoint へ集約する。

History 経路は `POST /documents/{handle}/history/operate`。`_history_body` が action/kind/metadata と identity・revision・save ID を検証し、`_history_unsettled`、Recipe の未完了保存、History が見ている Recipe fingerprint と Native document fingerprint の一致を確認する。`_history_save` は immutable request と stage を保持する。既存 History／Recipe snapshot を Native readback と照合し、必要ならその基準 snapshot を復元してから操作を適用する。完了後に `develop.get` 由来の完全設定 snapshot を使い、Recipe revision の CAS と History step append を行う。

Recipe は別の `/recipe` 経路で保存される。History の commit/operate は SQLite transaction 内で Recipe revision、History cursor/step、save receipt を更新し、通常はその Recipe snapshot が現在値となる。History が初期化されていない RAW では、最初の operate の `baseline_settings` に直前の保存値を渡して履歴 baseline を構成する。`mutate_raw_edits` が Immich thumbnail 更新との調整を行う。Point Color の追加・削除・調整は既存 `operate` の追加・削除境界に載せ、単なる Recipe save や直接 `/controls` へ接続しない。

WB 採色は Native 候補計算を `prepare` 内で行い、同じ History operation 内で選択値を適用し readback する。`_history_wb` は Native が候補を適用済みか再確認するため、途中再試行で候補を二重適用しない。Mixer ターゲットは専用 interaction route がドラッグ中の Native updates と preview を管理し、Pointer-up の History `operate` が interaction を終了、最終 snapshot を読み、History transaction を確定してから interaction owner を `confirm_mixer_interaction` で解放する。Curve も対応する begin/update/end/cancel と History `operate` を使う。普通の Mixer 数値 control は indexed でないため `controls` → History metadata → `apply_history_operation` の固定 allowlist を通る。

### 共有できる排他と Recovery

`_history_unsettled` は未完了の History save と geometry gesture を拒否し、endpoint admission は `_history_draining`、discard/close と task/preview lease を確認する。`_history_verify` は document object、handle/generation と `recipe_identity` を再検証する。`LightCraftRawSession._submit` が command queue lock、active photo、session generation、lost/desynchronized、Curve/Mixer owner を確認する。`_mutate` は expected revision と pending revision を再確認し、送信前に `library.select` で Native active photo を対象 document に合わせる。従って Point Color 専用 lock は追加せず、History owner と既存 mutation queue を共有する。

Native mutation 後の readback mismatch や設定取得失敗を成功とみなしてはならない。`_mutate` は送信前後の失敗を区別し、送信後に結果が不明なら session/photo を desynchronized 扱いにして通常操作を止め、既存の reset/reopen/recovery 経路へ渡す。追加は相対的・非冪等なので同じ pick を再送しない。History request/save ID と fingerprint は DB commit の再送を冪等にするが、Native pick の再送を安全にするものではない。Pending History は同じ immutable request の DB receipt を先に確認し、完了済みなら Native command を再実行せず応答を再生する。

Native mutation が完了してから SQLite append に失敗した場合、既存実装は保存段階 `stage=save` と同じ save ID/request fingerprint を維持する。Recovery では Native 設定を再取得し、recipe/history receipt を照合して commit の再試行または操作復旧を判断する。History 未記録の結果を通常編集として成功応答せず、`raw_history_save_pending` 等で後続操作を止める。client retry は同じ request/save ID を使い、異なる操作を新規送信しない。Native の結果が不明、または保存状態を確定できない場合は desync/recovery を必要とし、正常な編集状態を仮定しない。

### Point Color 操作の接続先

| 操作 | Native command | 接続する既存 owner と検証 |
| --- | --- | --- |
| 設定取得 | `develop.get` | Native session の `get_settings`。完全 snapshot の `point_colors` を adapter で検査。 |
| 採色・追加 | `pointColor.pick` | History `operate` の prepare/apply stage。保存済み snapshot と個数を確認後、座標を検証し一度だけ送信。append と初期値、戻り index を readback で照合。 |
| 削除 | `pointColor.delete` | History operation adapter。対象 index と配列形を事前確認し、削除後配列が index のみを除いた snapshot と一致することを検査。 |
| 8 controls 編集 | `develop.set` | 既存 `apply_history_operation` と `raw_controls.py` の control validation/location/readback 群へ index-aware control を追加。許可する8 suffix、存在 index、有限数・範囲、no-op を検査。 |
| 個別 Reset | `develop.resetControl` | 同じ index-aware control adapter。対象値だけ既定値になり、他 fields と配列要素が保持されることを確認。 |
| 全体 Reset | `develop.merge {settings:{point_colors:[]}}` | History operation adapter の専用 semantic operation から明示配列を送る。`develop.resetSection(pointColor)` は使わない。readback が空配列と一致することを確認。 |

Index は DB ID ではなく各確定 snapshot 内で解決する。request に document identity、generation、document revision、settings fingerprint、save ID を含め、History 基準と Native active photo が一致する区間だけ mutation する。全 Native response は状態変更の十分条件にせず、完全 readback を確定 snapshot とする。

### P1-A1〜A3 の実装分割

1. **P1-A1a — データ検証**。`raw_controls.py` に配列・indexed control・座標・index・値の純粋validation helperを追加する。
2. **P1-A1b-1／A1b-2 — 内部Native helper**。`lightcraft_runtime.py::_raw_command` の最小allowlistと `lightcraft_raw.py::LightCraftRawSession` の採色・削除・indexed set/reset・配列Resetを追加する。既存 `_mutate`／command queue／revision／owner 検査と完全snapshot readbackを使う。これらhelperはHTTPやHistoryに未接続で、公開APIを追加しない。
3. **P1-A2a — History operation 契約**。Point Color kind、metadata schema、Request単体validationと正規化のみを定義する。実行／保存allowlistには加えない。
4. **P1-A2b — Native operation bridge（実装済み）**。`lightcraft_raw.py::apply_history_operation` からA1b内部helperへ接続し、Native snapshot依存の配列・index・8件上限validationをmutation直前に実施した。API入口と永続化validatorは閉じたまま。
5. **P1-A2c — History／API接続**。既存 `windows_raw_api.py::_history_body`／`_history` と `raw_recipe_store.py::_history_metadata`／`_operation` に契約を接続し、immutable request fingerprint、History append、同じsave IDのrecoveryを有効化する。新しいHTTP routeは追加しない。
6. **P1-A3 — API経由の統合回帰テスト**。既存 `/history/operate` 経由のrequest/response、identity/revision/save ID、拒否・競合・readback・store failure/recoveryをMock Nativeで確認する。合成PNGの実CLIが使える環境ではNative契約を確認し、実RAWの受入はDesktop検証と分ける。

この分割で専用 lock、永続 Point Color ID、独立の変更保存系は不要。adapter を History 以外から呼べる形にする場合は internal module/service 境界で呼び出し元を制限し、未履歴 mutation を選べる公開 API にしない。

### P1-B への引き継ぎ条件とリスク

P1-B は保存済み完全 snapshot を source of truth にして追加・削除・8 control・Reset を `operate` へ結線し、各操作の可視ラベルと metadata schema を確定する。P1-A の各 method を直接 UI から呼ばず、UI は History save が完了した response snapshot だけを採用する。採色中に写真が切り替わる競合は document/generation/revision check で拒否し、Native command を再送せず同じ save ID の Recovery に回す。

残るリスクは、Native の Point Color index が削除後に移動すること、`develop.set` が存在しない index を成功応答の no-op にすること、`develop.merge` が8件上限や indexed slider clamp を保証しないこと、Native mutation 成功後の store 障害で Native と Recipe が一時的に乖離すること。完全 readback、入力境界、immutable History request/recovery によって扱い、8件超 snapshot は切り捨てず拒否・回復対象にする。DB migration や Native patch はこの接続に必要ない。

## P1-A1a — Point Color データ検証基盤

`backend/raw_controls.py` に純粋な検証 helper を追加した。`validate_point_colors` は snapshot の `point_colors` 配列と各要素の正確な11 Native field、数値の finite 性、L 0–1、C の非負、hue 0–360未満、8つの調整値の各Native control範囲、通常操作上限8件を検証する。入力配列を変更せず、順番・重複・f64相当の小数値を保持する。Native の serde が配列長を8件に制限せず、9件超を保持できる点と、GenzoRoomの通常操作で許容する上限を区別した。既存snapshotが上限を超える場合はこの検証でエラーになり、呼び出し側で削除・切り詰めを判断しない。

`validate_point_color_control` は厳密な `pointColor.<index>.<field>` 形式、8項目の allowlist、既存要素の index を確認する。`validate_point_color_value` はbooleanを除く finite numeric と項目範囲を検証し、整数化・clampを行わない。採色座標、削除 index、追加上限には `validate_point_color_coordinates`、`validate_point_color_delete`、`validate_point_color_append` を用意した。これらは P1-A1a 時点では既存 operation/API から未呼出で、固定 control validation も変更していない。

## P1-A1b-1 — Native 採色・削除の内部接続

`LightCraftManager._raw_command` の既存 allowlist に `pointColor.pick` と `pointColor.delete` の2 commandだけを追加した。`LightCraftRawSession._pick_point_color` と `_delete_point_color` は内部用 helper として `_mutate`／`_submit` に接続し、HTTP・Frontend・History operation からは未公開・未呼出。操作前に Native `develop.get` で完全設定を読み、`validate_point_colors` と座標／上限／index helper を適用してから一度だけ変更 command を送る。採色応答の index は追加位置と照合し、完全 snapshot の readback で件数・既存全要素・追加 OkLCh 中心を検証する。削除は readback の全配列を削除対象以外の順序・値と照合する。採色や重複色の排除・計算は GenzoRoom では行わない。

mutation 後の Native error、応答不明、readback error／不一致は成功扱い・自動再送せず、既存 `_mutate` の desynchronized または `_submit` の session-lost 経路に委ねる。非冪等な採色・削除を独自 rollback しない。事前 validation・revision・document identity・generation、Native queue、Curve／Mixer owner 排他は既存境界を再利用する。History 統合まではこれら helper を通常編集・保存・Export 経路へ接続しない。

Mock Native focused tests は Point Color テスト 16 件が成功し、追加・同一点の独立追加、先頭／中間／末尾削除、上限・空配列・不正 index、Native error／応答不明／readback不一致・失敗、応答 index、revision、Curve／Mixer 排他、lost／desynchronized を確認した。P1-A2 ではこれら内部helperをHistory operation ownerから呼び出し、History保存・同一save IDのRecoveryへ統合する。製品操作入口を追加する前に、History save failure とretry境界をそのoperation ownerで扱う。


## P1-A1b-2 — Indexed control・Reset の内部接続

`LightCraftRawSession` に `_set_point_color_control`、`_reset_point_color_control`、`_reset_point_colors` を追加した。いずれも `prepare`／`readback_check` を使う `_mutate` の内部helperで、公開Windows API、Frontend、History operation、Recipe、Exportからは呼び出さない。indexed helperはNative snapshotを取得して配列・control ID・値を検証し、完全snapshotのPoint Color配列に対する他要素・他fieldの保持をreadbackで照合する。数値はNativeの`develop.set {control,value}`、個別Resetは`develop.resetControl {control}`、全体Resetは`develop.merge {settings:{point_colors:[]}}`へ接続した。全体Resetでも配列以外の完全snapshotが維持されることを照合し、`develop.resetSection`は使わない。

指定値が既存値と同じ個別操作、既定値へのReset、空配列Resetは正常なno-opとしてNative mutation commandを送らない。Nativeが成功応答しても readbackが期待値と異なれば成功扱いせず、`_mutate`のdesynchronized／`_submit`のsession-lost処理へ渡す。Native error・応答不明・readback失敗でも自動再送しない。revision、document/generation identity、Native queue、Curve／Mixer排他は既存機構を利用し、専用lockや永続IDは追加していない。

Mock Nativeではindexed set 8項目、先頭／末尾 index、小数保持、他値保持、範囲・field・index拒否、成功応答のno-op検知を検証した。個別Reset 8項目、既定値復帰、他値保持、既定値no-op、不正ID、成功応答no-op検知、配列Resetの複数項目・空配列no-op・他設定保持・成功応答no-op検知、Native error／応答不明／readback失敗、revision・Curve／Mixer排他・lost／desynchronizedを確認した。Point Color focused 54件、RAW Session全体134件、固定control regression 2件、runtime世代guard 1件が成功。実Native CLIはこの環境に実行ファイルがなく未実施。

P1-A2bでは本節の内部helperをHistory operation dispatcherへ接続した。P1-A2cではHistory appendとsave failure後の同一save ID Recovery、および既存API validation／store metadata allowlistの接続を行う。P1-A3は既存History API経由の統合回帰テストを担当する。未保存mutationを通常APIやExport経路へ直接公開してはならない。

## P1-A2a — History operation 契約

Point Color operation kind は `pointColorPick`、`pointColorDelete`、`pointColorControl`、`pointColorControlReset`、`pointColorReset` とする。metadata schema は順に `{x,y}`、`{index}`、`{control,value}`、`{control}`、`{}`。既存camelCase History kind と衝突せず、各操作を個別に識別する。

`raw_controls.py::validate_point_color_history_operation` は厳密なkind allowlist・metadata key集合・型・finite性・座標範囲・control構文／値範囲・非負整数indexをRequest単体で検証する。`validate_point_color_control` と `validate_point_color_delete` は `count=None` で構文・型だけを検証でき、Native snapshot取得後には既存のcount引数でindex存在を検査する。採色の8件上限と現在の配列正常性もsnapshot依存であり、P1-A2bで`validate_point_color_append`／`validate_point_colors`を使ってNative command直前に検証する。A2aの検証helperはNative Sessionを呼ばない。

metadataは既存storeの `_json` と同じくkey sort・compact JSON round-tripで正規化する。数値型の変換・丸めはせず、座標とsliderの小数、index、controlを落とさない。既存History APIのrequest fingerprintはcanonical JSON化したbody全体から作られ、metadata差分も同じsave IDのimmutable receipt照合で衝突する。A2aではrecipe store、`validate_history_operation`、公開APIのallowlistを拡張していない。従ってこれらkindは純粋schema helperで認識されるだけで、`/history/operate` と `_history_metadata` では拒否され、Native mutation／History保存は実行できない。既存operationによる回帰testで同じsave IDのmetadataを変更したrequestが`raw_history_save_id_reused`となり、Native command／DB更新が起きないことも確認した。

Mock validation／回帰testは正常metadata5 kind、欠落・余分key、不正kind／型、NaN／Infinity、座標範囲、index型・符号、小数保持、control/value検証、snapshot依存確認の延期を対象にした。Point Color／A1a／A1b・固定Mixer control focused selectionは103件、契約・既存Mixer／Curve／WB／公開API・store回帰selectionは52件、save ID metadata fingerprint確認は2件が成功した。A2a時点で残していたA2bのNative snapshot依存検証と内部helper dispatchは次節で完了した。P1-A2cは既存History save／APIへ安全に開通する作業を残す。

## P1-A2b — 内部History dispatcher接続

`LightCraftRawSession.apply_history_operation` がA2aの`validate_point_color_history_operation`を呼び、`POINT_COLOR_HISTORY_SCHEMAS`でPoint Color専用kindを判別してA1b helperへdispatchする。対応は`pointColorPick` → `_pick_point_color`、`pointColorDelete` → `_delete_point_color`、`pointColorControl` → `_set_point_color_control`、`pointColorControlReset` → `_reset_point_color_control`、`pointColorReset` → `_reset_point_colors`。戻り値は既存operation同様、Native readback後に`_mutate`がcommitした完全`DevelopSnapshot`。

配列・上限・index・field・valueのsnapshot依存validationはA1b helperの`prepare`内でNative command直前に行う。dispatcherはsnapshotを取得せず検証を重ねない。各helperの`_mutate`がDocument identity／generation／expected revision／Native queue／Curve・Mixer ownerを検査し、readback不一致・Native error・応答不明を既存desynchronized／session-lost境界へ渡す。

接続先は内部Session dispatcherだけである。`windows_raw_api.py`の公開History kind validationと`raw_recipe_store.py`のmetadata allowlistはA2a時点のままPoint Color kindを拒否し、History step append、save ID／request fingerprint、Recipe、HTTP routeは変更していない。P1-A2bではHistory DB保存やsave failure後のretryを行わない。

focused Backend testsはdispatcher直接呼出し11件、RAW Session全体145件、公開API／store拒否と既存Curve・WB・fingerprint回帰27件が成功した。P1-A2cでは既存`/history/operate` request validation、store metadata validation、保存receipt／Recoveryを一体で有効化する。A2c前に公開kind allowlistだけを先行して開かない。

## P1-A2c-1 — History Store metadata契約

`raw_recipe_store._history_metadata` はPoint Colorの5 kindを認識し、`raw_controls.validate_point_color_history_operation` にmetadata検証と正規化を委譲する。Store側にPoint Color専用のキー・型・範囲検証を重複実装せず、validation errorは既存契約の `InvalidRawHistory` に変換する。既存の`_json`によるkey sort・compact JSONとmetadata byte上限を維持し、座標・control値の小数、index、control IDを変更しない。

許可するschemaは `pointColorPick:{x,y}`、`pointColorDelete:{index}`、`pointColorControl:{control,value}`、`pointColorControlReset:{control}`、`pointColorReset:{}`。既存step/cursor、Recipe revision、save ID・fingerprint、immutable receipt、transaction、undo/redo/jumpの実装とDB schemaは変更していない。Storeのappend契約がmetadataを受け入れることとHTTP操作を公開することは別であり、`windows_raw_api.py`のkind allowlistは変更せず、`/history/operate`は5 kindを拒否しNative mutationを行わない。routeも追加していない。

Store focused testsは5 kindの保存・readback、canonical JSON key順序、小数保持、不正kind／key／型／finite性／範囲／control拒否を確認する。既存History kindと公開API隔離・save ID fingerprintの関連テストも実行する。P1-A2c-2ではHistory operationの実行可否と保存契約を接続するが、API kind allowlistを開く前にrequest validation、Native操作、readback、Store receiptの境界を一体で扱う。

## P1-A2c-2 — History API・永続化経路

既存`POST /documents/{handle}/history/operate`のrequest validationが5 kindを`validate_point_color_history_operation`で検証するようにした。既存の厳密なrequest key集合により`curvePoints`やinteraction IDなど無関係payloadを拒否し、Document identity/generation、document revision、Recipe revision、save IDは従来の`_history_body`／`_history`契約で検査する。新しいrouteや別のNative実行経路は追加していない。

History operationはP1-A2bの`LightCraftRawSession.apply_history_operation`へdispatchし、各A1b helperがNative snapshotを取得して配列正常性・上限・index・field/valueを検査し、mutation後に完全snapshotをreadbackする。API側ではNative snapshot依存のPoint Color validationを重複していない。完全snapshotを既存`append_raw_history`へ渡し、同じSQLite transactionでRecipe revision、History step/cursor、save receiptを更新する。Recipeとstep snapshotのPoint Color配列、順序・重複・小数をMock Native経由のHTTP統合で確認した。

正規化metadataを含むimmutable request bodyから既存transport fingerprintを生成し、同じsave IDの異なるmetadata/payloadを拒否する。保存receiptがあればNative mutationを行わずresponseを再生する。Store保存前の失敗は成功応答せず`stage=save`を保持し、後続の別編集を`raw_history_save_pending`で拒否する。同じrequestのretryはStore保存を再試行し、採色を再送しない。Native未変更で確定できるPoint Color snapshot validation／Curve・Mixer owner拒否ではin-memory History ownerを解放し、失敗後にsessionが不用意にlockされないようにした。不明結果やreadback不一致は従来のdesynchronized／recovery境界を維持する。

Indexed setが同値、indexed resetが既定値、全体resetが空配列の場合、A1b helperはNative mutationを省略する。Storeは従来どおり同じsnapshotを新stepにせず、`ack.changed=false`のreceiptを保存する。API focused testsでこのno-op、全5 kindのHistory metadata、永続Recipe/step snapshot整合、8件上限、不正index、revision、Curve/Mixer排他、同一save ID再利用、採色の保存失敗後retryを確認した。`test_raw_controls.py`、`test_raw_history_store.py`、`test_raw_category_operations.py`、`test_raw_history_api.py`の関連4 suiteは310件成功した。P1-A2c-3ではNative/SQLite間の不明結果、再open後の復元、receipt replayをPoint Color固有に追加確認し、旧Recipe互換処理の要否を扱う。

## P1-A2c-3a — History保存・Recovery整合性

状態遷移はrequest validation → document/generation/revision・Recipe revision確認 → pending owner `stage=readback` → Native readback／保存済みsnapshotとの一致確認 → `stage=applying` → A1b helperのNative command・完全readback・Session commit → `stage=save` → `_history_verify` → `append_raw_history` transaction（Recipe CAS、History step/cursor、recipe/history save receipts）→ SQLite commit → `stage=complete` → HTTP応答。SQLite commit後から応答までに所有権確認が失敗しても成功応答へ進まず`raw_history_save_unknown`とし、次の同一requestはreceiptから再生する。

保存前のStore failureでは`stage=save`とimmutable request/fingerprintを保持し、成功応答せず別requestを保留中として拒否する。同じsave ID・payloadのretryは保存だけを再試行し、Point Color Native commandを再実行しない。Store commit後に例外を注入した場合も、retryは既存receiptを読み、History stepを重複追加せず`replayed=true`を返す。採色と削除の両方でtransaction前失敗・commit後応答不明を確認した。

Native mutation後の例外では`_mutate`が送信attemptを数え、結果不明・readback失敗・不一致をdesynchronized/session-lostにする。監査で、`stage=applying`のPoint Color retryが通常のreadback/restore後に非冪等な採色を再実行し得ることを確認した。このstageではsame requestのretryも`raw_history_operation_outcome_unknown`で止め、明示`/recover`のみがdurable Recipeへ戻せるようにした。save receiptの照合はこのguardより先なので、commit済みrequestはreceipt replayできる。Mock障害注入では採色・削除それぞれのunknown-after-mutation、readback failure、不一致後に対象Native commandが1回だけであること、ownerが保持されること、別編集が拒否されること、明示Recovery後にNative/Recipeが一致しownerが解放されることを確認した。

owner解放はPoint Color error codeの列挙だけでは判定しない。Native readback／helper実行の前後で既存`RawStatus.edits`とsession stateを比較し、mutation attemptが増えずsession stateが`synced`の場合だけ保留ownerを解放する。A1bの`_mutate`はNative command直前にattempt countを増やし、送信後の例外はsessionをdesynchronizedにするため、この2条件は「Native変更の可能性なし」を示す。invalid index、8件上限、control、revision、Curve／Mixer排他後は次の正常操作が開始でき、送信後の不明結果ではownerを維持する。

no-op set/reset/array resetはNative mutationもHistory step/cursor変更も起こさず、`ack.changed=false`のreceiptを作り、同一save ID retryはreceipt replayする。既存Storeのreceipt/CAS契約によりRecipe revisionはno-op operationでも1進む一方、Recipe settingsとHistory cursorは変わらない。このrevision更新は本件だけの意味変更を避け、既存の全History no-op契約を維持した。recipe revisionまで据え置く新しいreceipt形式への変更は行っていない。

Mock Native／SQLiteの障害注入・Curve/Mixer/WB regressionを含む関連5 suite（`test_raw_controls.py`、`test_raw_history_store.py`、`test_raw_category_operations.py`、`test_raw_history_api.py`、`test_lightcraft_raw.py`）は464件成功した。Native CLI試験、process restart後の再open、Undo/Redo/Jump復元、旧Recipeの欠落`point_colors`対応は本phaseでは未実施。P1-A2c-3bではこれらのrestore経路だけを確認する。

## P1-A2c-3b — History／Recipe復元整合性

Undo／Redo／JumpはPoint Color専用処理を追加せず、既存Historyの完全snapshot選択と`restore_persisted_settings` → `_restore` → `develop.reset`／`develop.merge`を使用する。`_restore`はdevelop設定変更前に復元snapshotを解析し、`complete_snapshot_for_merge(..., restore_point_colors=True)`で欠落したserde-default配列だけを`[]`としてNative向け完全payloadへ補完する。明示された不正型・不正entry・非有限値・8件超過は`validate_point_colors`で拒否し、補正・切り詰めない。補完後の完全snapshotをmergeし、readbackと比較用snapshotを照合する。不一致やNative失敗は既存`_mutate`のdesynchronized／session-lost経路を維持する。

Recipe／History保存JSON、save receipt、DB schemaは変更しない。`complete_snapshot_for_merge`の通常呼出しは欠落キーを補わず、保存payloadへの漏出を避ける。`settings_snapshot_for_comparison`は比較時に限って欠落を空配列として扱い、明示値は同じ8件・field・finite性validationに通す。Windows APIの揮発性settings fingerprintも、Point Color欠落を空配列相当として比較する。これは古いsnapshotと現在のNative defaultの照合用であり、Store receipt fingerprintや保存済みJSONの再計算・更新には使わない。

Mock NativeのHistory API系列（空baseline → 採色2件〔重複含む〕 → 小数indexed edit → index 0削除 → 全体Reset）で、各履歴位置へのUndo、Redo、任意step／baselineへのJumpを行い、配列順序・重複・小数値とRecipe／Nativeの完全snapshot一致を確認する。History移動は保存済みsnapshot復元のみで、採色・削除Native commandの再実行はない。2件の編集snapshot位置でDocument close／reopenし、配列・History cursor/stepとDB行が維持されること、再openがHistory step／採色を追加しないことを確認する。

別のMock History fixtureでは、過去のbaselineとRecipeに`point_colors`キーがなく、現在のstep／NativeにはPoint Color entryがある状態を作った。Undoは配列を明示的に空にし、Redo／Jumpで小数を含むentryを戻し、再度baselineへJumpしても配列が残留しない。元baseline JSONは欠落キーのまま不変。Recipe reopen試験もNativeに採色entryがある状態から旧Recipeへ復元し、空配列化とDB全行不変を確認した。`None`、不正entry、9件配列はNative commandを送る前に拒否し、同期状態・revisionを維持する。

関連focused tests（`test_raw_controls.py`、`test_raw_recipe_restore.py`、`test_raw_history_api.py`、`test_lightcraft_raw.py`）320件が成功した。Undo／Redo／Jump、空・複数entryのclose／reopen、小数・重複保持、旧Recipe／History snapshot、明示不正値拒否、および既存Recipe restore regressionをMock Nativeで確認した。未実施の実Native CLI・GUI／Browser手動試験はユーザー側の実環境確認事項。Export、Frontend、Native patch、旧snapshotデータ自体の書換えは本phaseの対象外とした。

## P1-B — Windows LightCraft Export設定引き渡し

Windows Export Queueは保存済み・freeze済みRecipeの`settings`を`ExportRuntime`から`RawExportInput`へ渡し、既存`export_raw_artifact`が分離Native processで`develop.reset` → `develop.merge {settings: complete_snapshot_for_merge(settings)}` → `get_develop` readback照合 → Native `export` → 再readback照合を行う。Point Color配列はsettings JSONの一部としてそのままmergeされ、専用Export経路やGenzoRoom側の色変換はない。Mock Nativeテストで小数を含む配列がQueueの保存Recipeからmerge payloadまで保持され、readback照合後に既存Export処理へ進むことを確認した。

旧Recipeが`point_colors`を欠く場合も、Exportは新規の分離Native photoへimportした後、merge前に`develop.reset`する。省略フィールドはこのreset済みNative stateの空配列を保持し、`settings_snapshot_for_comparison`は欠落Recipe値を比較時のみ`[]`として扱う。既存JSONやreceiptは変更しない。Mock試験でlegacy payloadに配列キーがないこと、resetがmergeより先であること、readback比較が空配列と一致することを確認した。Native設定mergeが失敗した場合は既存`raw_export_native_failed`へ変換され、Export処理を進めずNative process／一時ファイルをcleanupする。

担当境界は、GenzoRoomがfreeze済み編集設定をNativeへ渡し、保存済み意図との設定snapshot整合と失敗処理を担い、RAW現像演算・Point Color色変換・JPEG encode／quality／画素内容はLightCraftが担う。テストは設定引き渡し、既定値、readback、Native適用エラーだけを扱い、JPEG画素比較や画質評価はP1/P2のGenzoRoom受入条件・将来工程に含めない。製品コード変更は不要で、既存のreset／merge／readback経路がPoint Colorを含む完全Recipeに対応していたため、focused回帰テストと本節の記録のみ追加した。Frontend実装へ進めるBackend上の阻害要因はない。

## P1-C0 — Frontend向けsettings API契約

`raw_controls.controls_state(snapshot)` はNative snapshotの `point_colors` を `validate_point_colors` で検証し、既存settings／History応答へそのまま投影する。旧snapshotでキーが省略される場合に限り `[]` を返す。明示的な不正値は `raw_invalid_point_colors` で拒否し、配列順序・重複・11フィールド・小数値を変更しない。settings response上限は16 KiBのままとした。最大8件分のPoint Color payloadは既存の設定・control仕様と合わせても余裕内であり、上限緩和は不要。

Frontendの `RawSettings.point_colors` と `RawPointColor` はsnake_caseのNative 11フィールドを型付けし、既存settings decoderが件数、厳密なentry構造、有限値・範囲を検証する。応答配列はそのまま返し、専用API・cache・state更新経路は追加していない。Backend focused testsは6件、Frontend `rawApi.test.ts`は182件成功。TypeScript checkとVite production buildも成功した。buildでは既存bundle sizeと依存側`use client` directiveのwarningが出た。変更はBackend projection、Frontend contract/test fixture、focused tests、および本節の文書に限る。UI、Point Color操作、History／Recipe保存、Exportは変更していない。

## P1-C1 — Point Color 表示・選択UI

RAW編集パネルのColorカテゴリで、Color Mixerの後・Color Gradingの前に折りたたみ式Point Colorセクションを配置した。折りたたみ状態は既存の`rawDevelopmentPanelUi.subcategories`設定を利用する。空配列では無効化したスポイトアイコンと日本語／英語の案内だけを表示し、採色済みではNative配列順のスウォッチを表示する。FrontendにOkLCh→sRGB変換処理がないため、本工程のスウォッチは中立色とした。狭い幅では折り返す。

選択indexは`RawAdjustmentControls`の一時React stateで、workspace／handle／generation／document tokenのidentityに結び付ける。初期はindex 0、空配列は選択なし、配列縮小時は末尾の有効indexへ補正し、Document identity変更時は先頭へ戻す。Recipe／Historyへは保存せず、選択クリックからNative mutationやHistory operationを呼ばない。focused UI／panel settings tests 21件、TypeScript check、Frontend build、`git diff --check`を実施した。次工程ではViewer採色や数値編集を接続する前にスウォッチ色表示の方式を決める。今回それらの操作・範囲表示は実装していない。

## P1-C1a — 採色中心色のスウォッチ表示

Native中心値の契約は`lum`が0〜1、`chroma`が0以上、`hue`が0以上360未満で、CSS Color 4の`oklch(L C H)`へそのまま渡せる。Frontend側でOkLCh→sRGB変換は行わず、各スウォッチのCSS custom propertyに`oklch(${lum} ${chroma} ${hue})`を設定し、ブラウザーに色域処理を任せる。CSS `@supports`非対応時は従来どおり中立色へfallbackする。

スウォッチは採色した中心色の目印に限り、他のPoint Color調整値は色表示に使わない。明暗どちらでも選択を判別できるよう、選択outlineと濃色の境界を維持した。Recipe／History、Native操作、画像処理は変更していない。focused testは色差、同じ中心値の一致、lum/chroma/hue反映、調整値の無視、配列順序・選択状態を確認し、ブラウザーの画素変換結果は検証対象にしていない。

## P1-C2a — 調整スライダー表示

選択中の配列entryから8項目（`hue_shift`、`sat_shift`、`lum_shift`、`variance`、`range`、`hue_range`、`sat_range`、`lum_range`）を既存`AdjustmentSlider`で表示する。範囲は順に−100〜100を4項目、0〜100を4項目、stepは1。数値欄は既存規則に沿い整数表示するが、Nativeの小数値・settings stateは丸めず変更しない。slider、number input、Resetはdisabledとし、unmount時の`onCommit`を含むcallbackは空実装で、Native／History操作を起こさない。

表示は既存`selectedPointColorIndex`相当の一時選択値と最新settings配列を参照し、選択変更、配列縮小、空配列、Document切替、History後のsettings更新に追従する。focused testsは項目順、日英ラベル、範囲・step、既定値相当の値、小数の表示丸めとsettings保持、選択切替、配列変化、disabled状態、操作callback未呼出しを確認する。P1-C2bでは表示専用制約を外す場合のNative History操作連携を扱うが、本節では数値編集・Resetを接続していない。

## P1-D1a — Point Colorスポイト待機モード

WBとPoint Colorは`useRawDocument`内の同じ一時picker ownerを共有し、Document identity（asset／generation／document token）に結び付けて排他する。Point Colorは配列0〜7件、編集可能なready Document、ColorカテゴリON、After表示で起動でき、8件・History pending／loading・edit lock・crop・Before表示では起動不可または解除される。起動前には既存WB pickerと同じく開いている編集gestureを保存キューでsettleし、既存のCurve／Mixer target modeを終了する。再クリック、Escape、Document切替、右編集パネル／Colorカテゴリ／Point Colorセクションを閉じたとき、Color OFF、crop、Before表示、Historyで編集不可になったときに一時ownerを解除する。Recipe／Historyには状態を保存しない。

`ImageViewer`の既存picker表示経路を利用し、crosshair、`ViewerPointLoupe`追従、Space一時Pan、Navigator外での既存pointer規則を維持する。Point ColorモードではViewerのpointer clickをpicker用に捕捉するが、採色callbackを無効にし、Native／History APIや`point_colors`へ到達させない。WBの採色callbackは既存どおり有効。8件上限はHookのavailabilityとdisabled buttonで表現し、active時は選択色・`aria-pressed`・解除用tooltip／accessible nameを更新する。関連4 test files・374件、TypeScript check、production buildが成功した。ブラウザーでの手動確認は未実施。次のP1-D1bで座標をPoint Color History operationへ接続する際も、このmode ownerと表示中frame identityを維持し、同じViewer clickを二重処理しない。

## P1-D1b — Viewer採色からHistory保存への接続

`ImageViewer`の既存picker pointer captureから`useRawDocument.pick`を呼び、ownerがPoint Colorの場合のみ`RawRecipeSave.operate({kind:'pointColorPick', metadata:{x,y}})`へ接続した。送信前にactive owner、After frame、正規化座標、表示surface URL／geometry／quality／maxSideとDocumentのworkspace・asset・handle・generation・token・revisionを照合する。WB pickerは従来の`wbPick` frame payloadを維持し、共有callback内でownerごとに単一分岐する。Space Pan、drag、pointer cancel、古いDocument/frameはHistory操作へ進まない。新規routeやNative直呼び出しはない。

採色中のクリックで待機ownerを解除してから一度だけ既存History saveを行う。成功settingsは既存receipt確定後の応答で更新され、配列へ楽観追加しない。settings配列の増加を確認して新しい末尾indexを一時選択し、既存スウォッチと8つの表示専用スライダーへ反映する。失敗時は通常のHistory save error/recoveryに委ね、独自再送せず、確定前の配列・選択表示を維持する。Point Color History step metadata `{x,y}`をFrontend response validatorとHistory表示に追加した。

Anshitsu RAW Previewのfocused testでAfterクリックの正規化座標、1回の`pointColorPick`、History経由の確定後にentry追加・末尾選択・スライダー表示、drag無操作、save失敗時の重複追加なしを確認する。`rawApi` focused testsはpayloadにframeを含めないこと、小数座標保持、history metadataの厳密validationを確認する。Space Pan／Escape／WB既存テストも維持する。Native色計算、JPEG画素、ブラウザー手動動作は対象外。次工程ではPoint Color数値編集・Resetを個別にHistory操作へ接続する。

## P1-C2b-1 — 数値編集のHistory接続

8項目の既存`AdjustmentSlider`を有効化し、通常RAWスライダーと同じoperation-boundaryで確定する。ドラッグ中・キーボード／ホイール連続操作・数値入力中はDocument identity、開始revision、選択index、field、開始値、draft値を一時保持し、PreviewやNativeへは送らない。確定時に対象identity／revision／配列indexがまだ有効でColorがONの場合のみ、既存`raw.operate`へ`pointColorControl`を一度送る。control IDはsnake_case設定名をNative契約のcamelCaseへ写し、例として`hue_shift`は`pointColor.<index>.hueShift`となる。スウォッチ切替時は既存`commitAdjustmentEdits`で先に確定し、Document／History状態が変わった未確定draftは破棄する。操作中の値は一時draftとして表示し、History応答後は返却settingsを正とする。失敗時も通常のoperation error/recoveryに従い、独自再送しない。Resetはdisabledのまま。

`RawHistoryOperation`、History response validation、動的slider identityに`pointColor.<0..7>.<field>`を追加し、未知field、index、非有限値、各field範囲外を拒否する。History行は`ポイントカラー調整 / Point Color adjustment`と項目名・metadataの確定値を表示する。既存Backend History APIはindexed controlの変更前値を`changes`に出さずmetadataに新値を持つため、旧値は表示しない。focused testsで8 control IDとvalue range、number／drag／keyboard／wheelの確定境界、selection switch、Document/revision stale draft、settings readback、save error時のdraft破棄、History response validationと表示を確認した。Anshitsu Preview、Point Color controls、rawApi、History displayの4 suite・400件、TypeScript、production buildが成功した。P1-C2b-2には個別Reset等の未実装操作が残る。

## Point Color Native readback比較修正

JPEGでの`raw_point_color_control_mismatch`は、Point Color control自体ではなく、NativeがLegacy WBのserde-default `wb.scale`を省略したreadback dictと、GenzoRoom側で`_settings_json()`により`scale: "legacy"`を補完した期待設定を直接比較していたことで発生し得た。数値変更・個別Resetのreadback検証は、実際値と期待値の双方を`_settings_json()`で正規化した構造にして比較する。Point Color対象値と他の設定を含む全体比較は維持されるため、対象値が反映されない場合と予期しない別設定の変更は引き続き拒否する。Mock focused testsではLegacy WBの`scale`省略時の数値変更・個別Reset成功、対象値no-opの拒否、対象外設定変更の拒否を確認した。既存のKelvin WBとPoint Color操作回帰も同じBackendテストで確認する。

## P1-C2b-2 — 個別ResetのHistory接続

8項目のResetを既存`AdjustmentSlider`から`raw.operate({kind:'pointColorControlReset', metadata:{control}})`へ接続した。control IDは選択中の有効indexと項目のcamelCase名から作る。Document identity、revision、選択index、配列entry、Color ON、操作可能状態をReset送信時に確認する。Resetは楽観的に値を書き換えず、History応答のsettingsで表示を更新する。既定値の項目はResetを無効にし、Backend no-opで不要なHistory stepを作らない既存契約に従う。

Reset操作では未確定のPoint Color draftを先に破棄し、Reset自体を単一History操作にする。これによりdraft commitとResetが同じHistory fenceへ競合することを避ける。Document／revision／selectionが変わった古いイベントは送信しない。History response validationはPoint Color indexed IDだけを持つ正確なmetadataを検証し、History一覧は対象項目とResetであることを日英表示する。focused testsは8項目のcontrol ID、2件目entryへの適用、数値draft／slider dragとの競合、ロック・Color OFF・既定値の無効化、成功後settings反映・失敗時の非楽観表示、History metadata validation／表示を確認する。Undo／Redo等の既存History経路と数値編集・WB／Mixer回帰も関連テストで確認する。

## P1-C3a — スウォッチ削除

Point Colorの8調整項目の下に、選択中のスウォッチを削除する「削除 / Delete」ボタンを追加した。右クリックメニューは共通`AdjustmentContextMenu`の位置補正・Escape・外側クリック・focus復帰を利用し、項目は削除1つだけとする。右クリックでは選択状態を変えず、メニューを開いた時点のDocument identity／revision／indexを削除時に再検証する。どちらの入口も`raw.operate({kind:'pointColorDelete', metadata:{index}})`を使用し、Nativeへ直接送らない。

History応答を受けるまでは配列を変更しない。成功後は返却settingsの配列を正とし、削除対象が選択中なら同じindexへ繰り上がった色（末尾削除時は直前、最後の1色なら未選択）を選ぶ。非選択色の削除では現在の選択色を維持し、削除indexより後ろならindexを詰める。Undo／Redo／Jumpによる配列長変化もHistory cursorと配列を見て有効indexへ補正する。

削除時は保留中のPoint Color draftを破棄し、sliderを再mountして古いindexを参照する未確定callbackを遮断する。削除中は二重操作を防止し、Document／revision不一致、編集ロック、Color OFFでは送らない。History失敗時は楽観的な配列・選択更新をせず、既存Recoveryに委ねる。Frontend focused testsは、選択色と右クリックした非選択色の削除、先頭／中間／末尾／単一色、削除後の選択、draft破棄、失敗時の表示維持、stale revision／Document、ロック／Color OFF、メニューのEscape・外側クリック・重複防止、History型／表示を確認する。

## P1-C3b — Point Color全体Reset

Point Colorサブセクション見出しの右側に、既存サブカテゴリResetと同じ`adjustment-category-reset`スタイル・フォーカス／キーボード移動処理で「リセット / Reset」を追加した。ボタンはセクション開閉ボタンと別要素で、開閉を切り替えない。配列が空、Color OFF、編集ロック／History操作不可、Point Color変更が進行中の場合は無効にする。

操作は`raw.operate({kind:'pointColorReset', metadata:{}})`のみを利用する。実行前にDocument identity／revision／配列を確認し、Point Color draftを破棄してスライダーを再mountし、削除と同じpending mutation refで二重実行を防ぐ。成功応答までは配列を楽観変更せず、確定snapshotが空配列なら選択を`null`にして既存スポイト案内へ戻る。失敗時は配列と選択を保ち既存History Recoveryへ委ねる。Undo／Redo／Jumpは既存History snapshotを正とし、配列と調整値を反映する。選択は有効indexへ通常補正し、Reset前のindexを永続化しない。

Frontend History operation／step型とresponse validationへ`pointColorReset`を追加し、step metadataは空objectだけを許可する。History一覧は「ポイントカラーをリセット / Reset Point Color」と表示する。focused testsは複数／単一entryのReset、payload、空配列への確定反映、draft破棄、失敗時の非楽観表示、空・Color OFF・ロック時の無効化、重複要求防止、Document/revision変更、Undo／Redo／Jumpでの配列・値反映、metadata拒否を確認する。

## Point Color全体ResetのNative比較修正

`_reset_point_colors()`のreadback比較も、既存の数値変更／個別Resetと同じく、Native readbackと変更後の期待snapshotを双方`_settings_json()`で正規化して比較する。Legacy WBでNativeが`wb.scale`を省略しても同じ設定として扱い、Point Color配列が空にならない場合や他の設定値が変わった場合は従来の`raw_point_color_reset_mismatch`で拒否し、既存desynchronized／History Recovery契約を維持する。Mock NativeのLegacy WB scale省略、Kelvin WB、配列reset no-op、対象外設定変更と、採色・数値変更・個別Reset・削除を含む`test_lightcraft_raw.py` 151件が成功した。

## P1-C4 — ドラッグ中のPreviewとHistory確定

Point Color controlの操作中Previewには、既存LightCraft Native interaction（`develop.beginInteraction` → `develop.set` → `develop.endInteraction`／`develop.cancelInteraction`）を使い、Curve／Mixerと同じSession owner・command queue・Draft Preview worker・History receipt境界へ追加した。4つの`point-color-interaction` endpointは同一Windows RAW API内の操作で、Document identityとrevisionを毎回照合する。操作中のNative working snapshotはSessionのdurable snapshotへ昇格させず、最終`pointColorControl` metadataを含むSQLite History保存が成功してからSession snapshotをcommitする。保存結果が不明な場合は既存save ID／receiptを使い、Native endを自動再実行しない。

Frontendは既存`AdjustmentSlider`のoperation boundaryを維持し、50ms cadenceで中間値を最新値へ集約する。Native updateは同時に1件、待機値は1件だけとし、各適用値に既存のDraft After Preview ticketを結び付ける。ドラッグ中はHistory／Recipeを書かず、Pointer Up／number／keyboard／wheelの確定時に最終値を1つの`pointColorControl`として保存する。値が開始値と同じ場合はNative interactionをcancelしHistory stepを作らない。pointer cancel、slider unmount、Document終了では確定前interactionをcancelし、読戻し後に通常Previewへ戻す。Native／Preview不明結果は再送せず、既存Session失敗・durable Recipe再読込Recoveryを用いる。

JPEGとDNGはWindows LightCraft Session、Native interaction、Draft Preview、History経路を共有し、GenzoRoomはLightCraftの色演算を実装しない。Point Color interaction endpointは通常control reservationを取得しない。通常編集用reservationを取得すると、そのreservation自身がinteraction beginを`raw_busy`で拒否するためである。Mock NativeでDraft readback、cancel時のbaseline復帰、History保存後のRecipe snapshot、Undo／Redoを確認した。Backend Point Color focused testsは`test_lightcraft_raw.py`、`test_raw_history_api.py`、`test_raw_category_operations.py`から94件、Frontend Point Color controls／`RawRecipeSave` focused testsは58件が成功した。TypeScript checkとproduction buildは成功した（既存bundle sizeと依存directiveのwarningあり）。実Native・Windows Desktopでの手動確認は実施していない。

### P1-C4 follow-up — Session release時のinteraction破棄

診断ログで、workspaceのNative reset/release後にも`raw_point_color_interaction_pending`が発生し、後続openが妨げられることを確認した。原因は`_join_operations()`がCurve／Mixer ownerだけを解除し、Point Color ownerとそのPreview ticket参照を残していたこと。join時にPoint Color interactionをfailedとして残存ticketをsupersededで完了し、非同期Native／Preview taskをjoinした後にownerを破棄する。Session reset／closeの双方がこの経路を通り、未確定working settingsは永続snapshotへ昇格しない。通常interaction中の別操作拒否は維持する。

Mock Nativeの実API経路で、interaction中のworkspace release後に別workspace／別Documentを開けること、release前のRecipe／Historyがdraft値を含まないこと、古いinteraction IDが拒否されることを確認した。Session unit testsではreset／close後の古いPreview ticket解決、古いIDの拒否、新Document open、失敗interactionのreset後の再openも確認した。Point Color focused Backend testsは3 test filesで98件成功した。実Native／Windows Desktopでの手動確認は実施していない。

### P1-C4 readback／Preview recovery follow-up

2026-11-15のDesktop診断ログは`raw_point_color_control_mismatch`と、その後のcancel要求に対する`raw_point_color_interaction_stale`のみを含み、Native readbackの対象fieldや数値は記録していない。このためログから実機で不一致だった設定項目は特定できない。`update_point_color_interaction()`と`end_point_color_interaction()`は、従来どおり`_settings_json()`で正規化した完全settingsを比較し、target値の不一致と予期しない別設定の変更をどちらも失敗として扱う。readback比較は緩和していない。

不一致時の診断として、`raw.pointColor.readbackMismatch`にcontrol、phase、sequence、および最大12個の限定差分を追加した。差分にはNative field pathと有限な数値だけを含め、設定全体・画像情報・文字列値は出力しない。Mockでは、指定値が反映されない場合の`point_colors[0].hue_shift`差分と、予期しない`light.exposure`差分を検出・記録し、interactionをfailed/desynchronizedにすることを確認した。実機の元の不一致fieldは、この診断を含む次のログがないと確定できない。

確認済みのLightCraft 0.20.0 managed binaryを使った実Native試験では、合成JPEGと合成DNGへ採色後、8項目すべてを小数値で`begin → update → Draft Preview → end → History確定`し、更新値のreadbackが一致した。これは報告された実機不一致の再現ではなく、JPEG／DNGの基本interaction契約の検証である。

Frontendでは、interaction update失敗後のNative cancelも失敗した場合に`RawControls.endPreview()`を必ず呼んでから既存workspace Recoveryを開始する。これにより古いPreview ownerがpresentation stateを握り続けず、取消し結果不明時は耐久Recipeからworkspaceを再作成する。focused Frontend testでPreview owner解放、表示settle、Recovery開始を確認した。Backend focused interaction testsは6件、合成JPEG／DNGの実Native testsは2件、`RawRecipeSave.test.ts`は9件成功。Windows Desktopでの手動再現は未実施。

#### 整数／浮動小数点数のreadback比較

追加のDesktopログでは`phase=update`、`control=pointColor.0.hueShift`の`raw.pointColor.readbackMismatch`が`mismatchFields: []`を出した直後に同じ不一致エラーとなっていた。原因は、期待snapshotの整数JSON表現（例`25`）とNativeのserde `f64` readback（例`25.0`）を、`_settings_json()`後の文字列で比較していたこと。診断側のPython比較は`25 == 25.0`を真とするため、差分が空なのに文字列だけが異なる状態を説明する。

`update`／`end`の両方で、既存`_settings_json()`正規化を維持した上で、JSON object／arrayの構造とkey・順序・非数値型を厳密に比較し、有限な`int`と`float`だけを数値的に比較する`_settings_values_equal()`を使用する。`bool`は数値と等価扱いせず、配列長・キー集合・文字列・その他型・非有限値の差は拒否する。Snapshotの保存JSONやHistory形式は変更しない。field差分診断は引き続き維持する。

Mockで`25`対`25.0`、`0`対`0.0`をupdate／endの双方で検証し、bool／数値、追加key、配列長、文字列、不正数値、および対象値未反映／対象外設定変更を引き続き拒否することを確認した。修正前の実Native試験は合成JPEG／DNGとも整数25で`update`が同じ`raw_point_color_control_mismatch`となり失敗、修正後は両形式の8項目（整数25・0と小数値を含む）で`begin → update → Draft Preview → end → confirm`が成功した。Mock History API試験は整数値を含む操作を1 History stepとして保存し、Undo／Redoで復元した。実機の元ログには実際の`expected`／`actual`数値がなく、例の25／25.0は再現試験で確認した型差である。

#### 連続ドラッグの最終値送信競合

2026-11-15の診断ログでは3回のPoint Color History確定が成功した後、4回目のHistory operateで`raw_point_color_interaction_conflict`となっている。直前にはDraft Preview完了とHistory開始が記録されているが、元ログにはPoint Color update ACK、control、requested/applied value、sequenceがなく、実機で実際に欠けた値やsequenceまでは確定できない。

Frontendではpump本体Promiseを`gesture.pump`に保持し、別の`.catch().finally()`連鎖が後から参照を消していた。Deferred testで、Native update ACKの継続中にPointer Upを差し込み、最初のpump本体が完了した直後かつ後始末前に最新値25をpendingへ置く順序を再現した。修正前はNative送信が`[12]`だけなのにHistory intentは25となり、Backendのend契約と食い違うことを確認した。

Pointer Upはpumpを待つたびに同じ参照なら明示的に解放し、pendingがなくなるまで直列pumpをdrainする。update応答sequenceを要求sequenceと照合し、NativeにACKされた値／sequenceが最後のgesture値／sequenceと一致してからPreview完了とHistory保存へ進む。ending後は新しい入力を受け付けない。これにより最終Draft値がRecipe／Historyへ先行して保存されない。

`raw_point_color_interaction_conflict`のBackend診断にはcontrol一致、interaction state、latest/applied sequence、requested/applied数値だけを追加し、設定snapshotは記録しない。History APIが明示的なHTTP rejectionとしてinteraction conflictを返した場合は、そのimmutable retry requestを破棄して既存cancel/readback経路で未確定Native Draftを戻し、Preview ownerを解放する。結果不明のsave failureでは従来どおり同一save IDのretry境界を保ち、Native更新を再送しない。

DeferredのACK直後Pointer Up競合は修正前に失敗（送信値`[12]`、History値`25`）し、修正後は`[12, 25]`をACKした後だけHistoryを確定する。20個の急速入力を含む別テストではNative updateが`[12, 32]`の直列2回に集約され、最終ACK前にHistoryを呼ばず、最終値32を1件で確定する。明示的conflict時の取消し・owner解放もFrontend testで検証する。Backendでは競合診断の限定項目とPoint Color interaction／History経路をMock Nativeで確認する。実JPEG／DNGのDesktop手動検証は未実施。

#### Point Color interaction確定値／Preview readback整合性

全体監査F1をDeferred Native commandで再現した。`update`が`develop.set(25)`中でも`end(value=0)`は`update_lock`の外で古いACK値0を検査し、Nativeキューではupdateの後にendを送っていた。結果としてSnapshot 25とmetadata 0を確定できる状態だった。endはupdateと同じ既存`update_lock`をNative end・readback・finalized遷移まで保持する。ロック取得後にinteraction object／ID、Document handle、baseline revision、control、open state、latest/applied sequence、最後にACKした値を再検証する。updateも同じロック取得後にstate／identity／sequenceを再確認し、end確定後に待機していた古いupdateをNativeへ送らない。要求値がACK値と異なればNative endを送らず`raw_point_color_interaction_conflict`で拒否し、正しい値だけを検証済みSnapshotと結果へ確定する。Native end送信後の通信不明／readback失敗は従来どおりfailed／unknownとdesynchronizedへ移行する。

監査F4はPreview後のNative readbackがPoint Color配列の形だけを検証し、既にACK照合済みだった`working_settings_json`を無条件に置き換えることで再現した。Preview後はreadback全体を既存`_settings_json()`で正規化し、最後にACKされた完全working snapshotと`_settings_values_equal()`で比較する。有限なint／float同値だけを許容し、bool、配列／キー構造、未反映の対象値、Point Color以外の差異も拒否する。不一致は限定field差分診断を出しinteractionをfailed、Sessionをdesynchronizedにし、未検証readbackをworking／History候補に採用しない。一致時もreadbackは検証目的に限り、Preview描画結果と履歴確定snapshotを分離する。Nativeの正規化で許容する具体的なPoint Color外差分は確認されていないため、例外許容は追加していない。

Deferred Mock testはF1のupdate待機中end値0を修正前に受理すること、F4のPreview readbackで対象値99または`light.exposure`変更を修正前に受理することを確認した。修正後は不一致endがNative endを送らず拒否され、25のACK値での並行endは1回の確定として成功する。また、end中にlock待ちとなった古いupdateはNative送信前に拒否する。Previewの対象値／対象外設定不一致はともにticket error、failed／desynchronized、durable baseline不変となり、誤った値でのend／History確定を拒否する。`test_lightcraft_raw.py`、`test_raw_history_api.py`、`test_raw_category_operations.py`は合計290件成功し、同一save ID retry／receipt replayと既存History／Recipe／Undo／Redoを含むMock API／SQLite回帰も通過した。receipt再試行の動作は変更していない。

receipt確認済みLightCraft v0.20.0 CLIで、合成JPEG／DNG各1件の既存real-Native Point Colorテストが成功した。各テストは採色後に8項目を含む`begin → update → Draft Preview → end → confirm`とNative readbackを通すが、今回のrace順序・Preview readback障害注入はMockでのみ検証しており、Windows Desktop実機の手動試験はしていない。Frontend focused testsは4 files／421件成功し、build内TypeScript checkとproduction buildも成功した（既存bundle size／依存directive warningあり）。

当時のF1／F4修正ではWindows API側のstage／owner解放を変更せず、F2を後続監査項目として残した。F2は次節で修正・検証した。

#### Point Color監査P2 — F2拒否時owner解放／F3短時間操作

F2の実HTTP＋Mock Native再現では、update ACK前にendが古い値を要求すると、Native `develop.endInteraction`送信前に`raw_point_color_interaction_conflict`となる。従来はAPI側のpending stageが`ending`のまま残り、競合がHTTP 502としてFrontendへ届くため、Frontendは結果不明扱いとなりHistory owner／Preview gestureを保持していた。

endのNative送信境界を明確にするため、`LightCraftRawSession`はNative command queue内で、revision確認後かつ`develop.endInteraction`呼び出し直前にinteraction stateを`ending`へ遷移させる。Windows APIは失敗時、同一pending ownerとinteraction IDがなお存在し、interactionがopenでSession statusがsyncedの場合に限りpendingを解放する。この状態はNative endを未送信と証明できる。送信を開始した後は`ending`／`unknown`／`failed`となり、pendingを保持して既存の結果不明・same-save-ID retry／SQLite receipt経路へ渡す。`raw_point_color_interaction_conflict`は既存History conflict群と同じHTTP 409で返し、Frontendの実HTTP parserも`outcome=rejected`として扱う。拒否後はFrontendがimmutable retry requestを破棄し、既存Native cancel/readbackでdraftを戻してPreview ownerを解放する。

F3は`finishPointColorInteraction()`が50ms pump timerをclearしても`gesture.timer`参照を残し、force flushのscheduleが既存timer有りと判断してreturnすることが原因だった。Timerをclearする箇所で参照も解放し、pending値を即時pumpできるようにした。Native updateは従来どおりACKを待ち、sequence／適用値が最終gesture値に一致した後でのみHistory確定へ進む。既存の50msドラッグ中集約は維持する。キャンセル時もtimer参照を解放し、draftを送らない。

修正前のF2統合テストは競合拒否をHTTP 502として観測し、pending ownerが残るためworkspace closeも`raw_history_save_pending`で拒否された。修正後はHTTP 409と正確なerror code、History／Recipe未変更、Native end未送信、owner解放を確認し、cancel後の新interaction・通常operation・workspace release・別Document openが成功した。Native end送信後の結果不明はHTTP 502／unknownのままpendingを保持し、retryでNative endを再送しない。SQLite commit前の保存失敗は同一save ID retryで保存され、commit後の結果不明はreceipt replayでHistory stepを重複追加しない。両ケースでNative endは1回だけである。

F3のDeferred Promiseテストでは修正前、10msでPointer Upした値38にNative update／History saveがなくcancelだけが呼ばれることを再現した。修正後は50msを待たず値38を送信し、ACK後に1件だけHistoryへ保存、Preview／interactionを解放する。初期値へ戻す操作ではHistoryを作らない。既存ACK直後のPromise cleanup race、50ms境界のpump集約、20件の短い連続gestureも確認した。

検証はMock NativeのBackend／HTTP／SQLite focused suite 424件、Frontend focused 4 files 426件が成功した。TypeScript check／production buildも成功（既存bundle sizeとdependency directiveのwarningあり）。receipt確認済みLightCraft v0.20.0 CLIでは合成JPEG／DNG各1件のPoint Color interaction testが成功した。実Native確認は正常系に限定され、F2／F3障害注入とWindows Desktop手動確認はMock／自動テストのみである。F5〜F8は未変更・未検証であり、今回の対象外とする。

#### Point Color監査P3 — F5離脱時のdrain／F6 Finish・Cancel所有権

F5では`prepareSave()`が未終了Point Color gestureをdrainせず、`saver.dirty`にgesture ownerが残るため、保存準備が完了しない経路があった。React cleanupもMixer／Cropだけを個別終了し、Point Color中は通常の`save()`だけを呼ぶため、Native interaction／Preview ownerを残したままrelease判定で停止していた。保存準備では入力をfreezeした後、`preparePointColorForDeparture()`をHistory待ちより先に呼ぶ。Open中のgestureは既存cancel APIを1回実行してNative cancel ACKとbaseline settings readbackを待ち、Preview／gesture ownerを解放する。FinishまたはCancelが既に所有している場合は、その同じPromiseを待つ。Document cleanupとdiscardも同じdrainを通し、Cancel／Finishが確定する前にworkspace releaseやabortを進めない。保存準備が成功した場合だけ通常のRecipe／History保存・Document切替を続ける。

F6ではPoint Color gestureに終了owner（`finish`または`cancel`）と各終了Promiseを持たせ、最初の終了要求が同期的にownerを確保する。同じ操作の重複呼び出しは同じPromiseを返す。Cancel先行ならFinishはCancel結果を待ちHistoryを作らない。Finish先行なら後続CancelはFinish Promiseを待ち、Native cancelを重ねて送らない。gestureはownerが決まった時点で入力を止める。Pump／Preview失敗や、F2でNative end未送信と確認できた拒否からの内部回復では、Finishが確定に失敗した後だけownerを明示的にCancelへ移す。History保存結果不明時はFinish ownerとimmutable retry requestを保持し、離脱を拒否する。retry付き保存準備は同じsave IDの既存requestを再生し、成功後にのみrelease可能となる。Native cancel／readbackが失敗した場合はlocal gestureをUIから解放して既存Recoveryへ渡す一方、Recovery完了までSaverをdirty／lockedのまま保ち、後続の離脱がreleaseを強行しない。Native end結果不明やCancel失敗を正常終了扱いせず、releaseを強行しない。

Document cleanupのreleaseは、終了Promiseがすでに予約した編集Queue処理の後ろに置く。Point Color cancellationはQueue外のAPI ACKを待つため、cleanup側が先にQueueを占有してその完了を待つ循環を避ける。連続操作の既存単一History保存・P1/P2のACK／retry／receipt契約は変更していない。Document離脱ではold saverが保持するDocument identityを使い、後続DocumentへDraftや応答を転送しない。

追加したFrontend testsは、open draftの反復`prepareSave()`とswitch、unmount時のDeferred Native cancel ACK待ち、History finish中のDocument離脱待ち、Cancel先行／Finish先行、Native update ACK中のCancel、Preview待機中のCancel、Finish／Cancel重複呼び出し、History結果不明で離脱を保留し同一save requestをretryする経路を確認する。初期値へ戻すno-op、50ms短時間操作、pump cleanup競合、F2明確拒否後cancelの既存回帰も保持した。Frontend指定5 filesは566 tests成功、TypeScript check／production build成功（既存bundle sizeとmodule directive警告あり）。実Windows Desktop手動確認はしていない。

F7（古いPreview worker／Promiseの遅延結果）とF8（Preview worker・世代管理の残存問題）は今回変更・検証していない。F5/F6の終了後にもPreview側の独立した古い応答問題が残る可能性があり、別工程の監査対象とする。

### Point Color監査P4 — F7 Preview worker ticketとF8 Draft Preview rejection

F7の再現原因は、Preview workerが`_control_idle.wait()`中にpending ticketをcancel／replaceされても、wake-up後にslotを再確認せず`_pending`と`_before_pending`から`None`を選択できることだった。`_ticket_current(None)`が`AttributeError`となり、generic exception handlerも`ticket.kind`を参照してworker taskを異常終了させる。待機復帰後にstop/reset状態と両slotを確認し、空ならloopを終了・再試行する。slot選択も存在するticketに限定し、例外処理でticketが存在しない場合に属性を参照しない。無効化されたticketのFutureは既存の`_discard_pending`／`cancel_preview`が完了させ、置換ticketは最新slotの所有権確認後にのみNativeへ進む。

Session reset／closeではcontrol idle eventがclearのままworkerが待ち続け、`_join_operations()`を止める可能性もあるため、既存eventをwakeして古いworkerをretireさせる。reset終了時はまだcontrol reservationを保持しているcallerがあればeventを再びclearし、resetのwake-upで新Sessionのcontrol fenceが開いたままにならないようにする。workerやqueueは追加していない。

F8は各Draft Preview Promiseを作成時に観測する。古いPromiseがgestureの最新Preview参照から置き換わった後もrejection handlerが残り、`RawSuperseded`とgesture／Document／controllerが古くなった結果は現在gestureへ転送しない。現在のgestureが所有するPreview失敗は既存のcancel・Recoveryへ一度だけ移し、そのPromiseをFinishも待っている場合にも終了処理を重複させない。cancelがbaseline表示と一時error表示を戻すため、Preview failureはcancel settle後にUIへ通知する。各元PromiseはFinishが必要に応じてawaitできる形を保ち、置換されたPromiseだけが未処理rejectionとして残らない。

修正前にBackendのcontrol wait中cancelを再現し、`_ticket_current(None)`と例外処理の`ticket.kind`でworkerが異常終了することを確認した。修正後のMockテストではcancel、置換ticket、reset、closeの4経路で旧Future完了・worker正常終了を確認し、置換またはcancel/reset後の次の有効Preview成功とNative render回数も確認した。FrontEndのDeferred Promiseテストは旧Preview失敗後の最新Preview成功とHistory Finish、最新要求の失敗からのcancel／UI error、Cancel後の遅延失敗、旧成功結果の無表示、Saver dispose後の応答破棄を確認する。修正前は旧Previewの遅延rejectをVitestが未処理rejectionとして検出し、修正後は検出しない。

共有経路のBackend回帰として`test_lightcraft_raw.py`と`test_raw_region.py`の188 tests、Point Color History API／receipt／retry 8 testsが成功した。Frontend Point Color／Preview関連5 filesは571 tests成功し、TypeScript checkとproduction buildも成功した（既存Vite bundle-sizeとmodule-directive warning、React testの`act()` warningあり）。Mock以外の実Native／実Desktop試験は行っていない。P1（F1/F4）、P2（F2/F3）、P3（F5/F6）の状態遷移は上記の関連回帰で維持を確認し、その設計は変更していない。P4ではF7/F8を修正した。F2〜F8全体の新たな網羅監査ではなく、今回のPreview経路に関わるF2/F3/F5/F6回帰のみ実施した。

変更対象はPreview ticketの待機・無効化とPoint Color Preview Promiseの寿命に限る。JPEG／DNG実Native正常系、Windows Desktop手動確認、P4以外のpreview generation問題は未検証であり、Native画像処理・History保存形式には変更を加えていない。

### 最終監査の修正 F9〜F11

- **F9** 最終Draft Previewを待つFinishは、まだHistory保存をキューへ登録していないことがある。cleanupが先にキューを取得すると、Finishとcleanupが循環待ちになる。Document離脱はキュー外で終了Promiseを待ち、その後で既存キューにworkspace解放を登録する。次Documentのopenは解放成功まで待機する。解放や保存が確定しない場合はopenを拒否する。Documentが残っている間の結果不明時は、従来どおり同じsave IDで保存を再試行できる。
- **F10** Draft Previewの `RawSuperseded` は配信終了として扱う。FinishはNative ACK済みの値とsequenceを照合して保存へ進む。それ以外のPreview失敗とNative readback不一致は従来の取消し／Recovery経路に進む。
- **F11** 明示的Cancelの拒否をUIで処理し、診断と該当Saverのエラー表示に反映する。Recoveryとdirty／lockedは既存Saverが管理し、再オープン後は新しいSaverで編集を再開する。

修正前は、Deferred Preview完了後もHistory保存に到達しないこと、`RawSuperseded` で確定が失敗すること、明示的Cancelの拒否をVitestが未処理例外として検出することを各テストで確認した。修正後はHistory保存、workspace解放、次Documentのopenの順序と、Cancel失敗後のRecoveryと再操作を確認した。

Frontend 607件、Backend Mock／API／SQLite 374件、実Native 8件（合成JPEG／DNGのPoint Color各1件を含む）、TypeScript、production build、差分チェックが成功した。実Nativeは正常系を確認し、離脱競合と障害注入は自動テストで検証した。Windows Desktop手動確認は未実施。

### 最終監査修正 F12〜F19 — RAW workspace終了所有権

#### F12〜F14：終了所有権への移行

F12では、通常releaseの応答喪失をrelease失敗として破棄せず、旧workspace IDを持つownerを残した。後続openは`rawWorkspaceEmpty(workspaceId)`を使ってBackendのcapability応答を照会し、`workspaceState === "empty" && cleanupPending === false`の場合だけ終了確認とする。このBackend状態は単一workspace manager全体の状態で、応答にIDは含まれない。Frontendはserialized ownerが保持する旧IDを使い、実際のrelease要求にはそのIDを含める。空でなければ同じIDで既存releaseを再試行し、409／404／503だけから終了済みと推測しない。`unknown/saving`はこのempty照会では解消しない。

F13では共通Recoveryのdiscard／create／open／settings各await後に、開始時のasset・workspace・handle・generation・document token等を確認する。旧UIが失効した後は結果をそのUIへ反映しない。create成功後に失効した場合は応答で得たworkspace IDを既存termination ownerへ渡して終了し、後続openはその終了確認まで待つ。create応答自体が失われIDを得られない場合は、別workspaceを推測して終了しない。

F14では明示discardにP1のSaver／gesture／Documentへ結び付くDraft限定discard証明を要求する。Cancelが失敗しても、開始時に確認した保存境界と証明を保持し、HTTP statusや`retryRequest`の不存在だけではdiscard可否を決めない。未確定History／Native end結果不明ならdiscardしない。Historyが確定したFinish先行ではdiscardで保存を消さず、通常releaseへ移行する。

#### F15〜F19：保存安全性と共通後始末

- **F15（`992b73d`）**：処理中flagの解除を保存確定と誤認し、未確定Historyを明示discardする経路を防いだ。Saverの`canDiscardWorkspace()`をdiscard開始時とBackend送信直前に確認し、未解決save ID／SQLite結果不明／Native反映とHistoryの不一致がある場合は旧Saver、retry request、workspace IDを維持する。P1のDraft限定証明は別契約として維持した。
- **F16（`1d57b0d`）**：Finishが先にownerとなってHistory保存が確定した場合は通常releaseへ移行し、Backend discardを呼ばない。Native／History結果不明ならreleaseもdiscardもせず旧Saverと同じretry requestを保持する。
- **F17（`d7491c3`）**：安全な共通Recovery discard送信後のHTTP応答喪失を保存結果不明と区別した。後続openは旧workspace IDを保持する終了ownerからcapability endpointのworkspaceState／cleanupPendingを照会し、emptyなら完了、非emptyなら元の安全条件を維持できる場合に限り同じIDで再試行する。empty照会の応答自体はworkspace IDを返さない。
- **F18（`a4bcdd4`）**：通常Document離脱も`RawWorkspaceTermination`へ接続した。保存settleは共有queue外、releaseは既存queue内で行い、成功または既存P2-Cの照合／再試行後だけ後続openを許可する。保存結果不明時はworkspaceをreleaseしない。
- **F19（`1d97b88`）**：明示discardのSaver／Editor／Preview等の後始末を最初のUI操作Promiseではなくowner共通完了経路に置いた。後続openからの再試行成功やBackend empty確認でも後始末する。`saving`、`releasing`、`completing`、`complete`を区別し、後始末失敗はBackend終了未確認と混同せず、終了APIを再送せず後始末だけを再試行する。終了成功時の旧Saver／Editor disposeとowner解放は一度だけ行い、UI更新は同一Document identityが有効な場合に限る。

P1〜P3-BおよびF15〜F19の各段階で、Deferred Promiseを用いたFocused／関連回帰テスト、TypeScript、必要なFrontend buildと差分チェックを実施した。個別工程で検証範囲と件数が異なるため件数は合算しない。直近のF18では7 test files・434 tests、F19では7 test files・439 testsが成功した。F19のTypeScriptチェック・production build・`git diff --check`も成功し、buildには既存のchunk size／React Router directive警告があった。F15〜F17の各工程のテスト範囲はそれぞれのCommit/task記録に従い、本節では総合件数を作らない。実機で全通信断・保存不明順序を再現したという意味ではない。

現行の終了所有者はReact hookより長くworkspace IDと必要なSaverを保持する。保存結果不明の`unknown/saving`は安全なHistory retryなしに解放しない。workspace終了結果不明の`unknown/releasing`は同一IDのBackend照合で復旧する。Backend終了済みで後始末だけ失敗した`unknown/completing`は後始末を再開する。終了が確定しない間は次Documentのopenを保留する。Windows Desktopの通常Point Color操作はユーザーが使用した範囲で問題なしと確認したが、通信断等を含む全異常系を実機確認したわけではない。

#### 残る既知の制約

- Backend create応答が失われworkspace IDを取得できない場合、Frontendだけでは作成済みworkspaceを特定できない。
- History／Native保存結果が不明の場合は、データ保護のためworkspace終了と次Document openを保留することがある。
- 多くの異常系はMock／自動テストであり、Windows Desktopで全て実機再現していない。
- P0調査時点ではPoint Colorの「範囲を表示」は未実装だった。公開契約は後続のP1-A／P1-Bで追加され、本書末尾に実装・検証結果を記録した。

## Point Color Range実装記録（P1-A〜P2-B、2026-11-19）

### 現行の利用者向け仕様

Windows Desktopでは、採色済みPoint Color項目に「範囲を表示 / Show Range」チェックボックスを表示する。削除ボタンと同じ行の左側に配置し、既存チェックボックスの見た目に従う。初期値はOFFで、未採色時は表示しない。スウォッチ切替、スライダーDraft、ズーム・パン中は対象範囲を追従する。BeforeとCrop編集、採色中は一時停止し、終了後に再開する。Point Color／親Colorの折りたたみ、Color OFF、写真切替、全項目削除はOFFにする。Undo／Redoは既存のスウォッチ選択・補正を用い、選択項目がある場合は範囲表示を維持する。ショートカットは追加しない。

範囲表示は一時的なUI状態で、Native settings、History、Recipe、appSettingsには保存しない。LightCraftの既存`Overlay::PointColorRange(index)`を選択中の1項目へ適用する。Nativeの現像アルゴリズムやOverlay描画処理をGenzoRoomへ複製していない。Windows版のRAW／非RAW共通Previewで利用し、Docker版は対象外。

### Native公開契約とmanaged patch

- LightCraft v0.20.0固定upstream commitは`192ff72923c39e6623f2c7ff67ab3a119deb8071`。
- managed patchは[`0001-v0.20.0-whole-frame.patch`](../../../native/lightcraft/patches/0001-v0.20.0-whole-frame.patch)、P1-B統合Commitは`b612afa`、更新後SHA-256は`5d67916cb9ed3b554e73bf21d3ac69614c4c75956fed1e5bab5f5c74b4efd564`。
- patchの変更目的はHeadless／MCPへPoint Color Rangeを公開し、既存Preview描画経路で呼出元が結果を識別可能にすること。LightCraft既存のOverlay描画処理、現像アルゴリズム、CPU／GPU経路、キャッシュ、メモリ管理には変更を加えていない。
- 主なNative対象は`crates/mcp/src/tools.rs`（`render_preview`／`render_region_preview` schema・引数）、`crates/mcp/src/headless.rs`（Whole／Region描画ジョブへのOverlay適用）、およびMCPテスト。既存の`RenderJob::with_overlay(Overlay::PointColorRange(index))`を利用する。
- Whole `render_preview`では任意の整数`point_color_range_index`（0〜7）を受け、通常のWhole render jobへ適用する。Region `render_region_preview`では`render`操作の`target`外側に同じ任意引数を置き、既存target schemaとplan操作を変えない。両方ともDraft／Fullを許可する。引数省略時は通常描画。
- 適用条件違反（不正／不存在index、Before、crop_edit、Region plan等）は明示エラーとし、Overlay指定を黙って通常画像へフォールバックしない。適用時だけ結果metadataへ`pointColorRangeIndex`を追加する。Frame、Geometry、品質、画像応答形式は維持する。
- managed patch統合時にはmanifestへ`pointColorRangeContract: 1`を追加し、build probe・build receipt・Native成果物照合処理から同契約を確認する。現行manifestとpatch記録のSHA-256は一致する。

### GenzoRoom統合経路

- Backend Whole Previewは任意`pointColorRangeIndex`をNativeのsnake_case形式の引数へ変換し、結果metadataが要求indexと一致することを検証する。HTTP応答は`X-Raw-Point-Color-Range-Index`で結果を返す。Full `frame_only`分岐も指定を維持する。
- Region renderは`target.pointColorRangeIndex`を公開schemaに沿ってNative引数のtarget外へ移し、Native metadataを既存Region応答検証へ渡す。`X-Raw-Region` metadataにも適用indexを含める。planにはOverlay指定を送らない。
- Point Color interaction updateとACKに紐づくWhole Draftは既存interaction ID／sequence、ticket、更新集約を再利用する。範囲表示条件が変わって旧Draftが失効しても、Native編集操作そのものは失敗扱いにしない。interaction中Regionは追加せず、終了後はFull／Regionへ戻る。
- Frontendは`useRawDocument`の一時UI状態と既存選択indexを使い、Whole／Region／Draft要求に有効なindexを渡す。通常表示では省略する。要求identity、応答metadata、decode後の採用境界、Region cache／tile再利用identityへindexを含め、異なる表示条件の応答やタイルを混在させない。BeforeとCropでは送らず、ズーム・パンは選択indexを保持する。
- Overlay切替とスウォッチ切替はNative settings revisionを変えずにPreviewを更新する。History／Recipe保存、Export、サムネイル要求に範囲表示状態を伝搬しない。

### 実装・検証履歴

工程ごとに対象が異なるため、テスト件数は相互に合算しない。

- **P1-A（Native契約）**：隔離LightCraft checkoutでMCP schema・Headless Whole／Region引数・metadataを実装し、Native CLIをビルド。Draft／Full、index 0と別index、通常描画省略、拒否条件、Frame／Geometry維持、設定不変をWhole／Region実CLI probeで確認した。現像・Overlayの画素品質検証は行っていない。
- **P1-B（正式Native成果物）**：P1-A差分を管理patchへ統合し、`pointColorRangeContract: 1`をmanifest、build probe、receipt、成果物照合へ反映。正式managed patchからCLIをビルドし、固定commit・patch適用・SHA・receipt・公開schema／Whole／Region probeを照合した。managed patch SHA-256は上記の値。
- **P2-A（Backend）**：Whole／Region／Point Color Draftへ任意indexを接続し、Native結果metadataとHTTP応答を照合。不正入力、metadata mismatch、Full `frame_only`、Region plan非伝搬、Export／thumbnail非伝搬などの対象API回帰を集中テストで確認し、正式CLIによるBackend公開境界probeを実施した。
- **P2-B（Frontend）**：UI状態、Before／Crop pause、Whole／Region cache identity、古い応答の拒否、Draft接続、設定／History非変更を関連Frontend testsで確認し、TypeScript check、production build、差分チェックを実施。Windows Desktopのユーザー実動作確認では問題の報告なし。
- **P2-B追加回帰修正（`7673ed2`）**：一時停止中に通常のPoint Color Draftまで拒否しないよう採用条件を修正し、共有`curveTarget`からPoint Color専用引数が他interactionへ漏れないよう型・呼出経路を限定した。関連集中テスト、TypeScript、production build、差分チェックを再実行した。

`AnshitsuRawPreview.test.tsx`の84件失敗は、P2-B前の`11916df`で56 pass／84 fail、P2-B後`5443777`の追加修正前は56 pass／85 failだった。差分比較では元の失敗テスト名とエラーが84件すべて一致し、P2-B固有の追加失敗はShow Rangeテスト1件（null要素参照）だった。そのテストを移動・修正した後は`5443777`比較が57 pass／84 failとなり、`11916df`の失敗集合と一致した。再現調査では、既存Curveテストが意図的なcommit失敗mockをretryせずに残し、後続テストへ状態を持ち越すfixture／mock残留を確認した。84件は実装前から存在し、P2-B回帰には分類されない。今回のP3ではその既存失敗を修正していない。
