# LightCraft Point Color 統合調査 P0

## 1. 調査対象バージョン・固定 Commit

- GenzoRoom の基準は `main` の `2874ebda76506d7191a88fb2efc8e211619bc312`。調査開始時の作業ツリーは clean で、ローカルの `origin/main` と一致。
- [manifest](../../../native/lightcraft/manifest.json) の LightCraft は v0.20.0、固定 SHA は `192ff72923c39e6623f2c7ff67ab3a119deb8071`（`Release 0.20.0`）。以下の Native ソース参照は `.tmp/lightcraft-0.20.0-p3` のこの checkout relative。
- [build.py](../../../native/lightcraft/build.py) の `manifest()` と書き込みなしの `prepare(..., apply=False)` が `patched` を返した。HEAD、upstream Cargo version、patch の SHA-256 と 17 targets、完全 diff、未追跡・staged source、Region schema を照合済み。patch は `0001-v0.20.0-whole-frame.patch` 1 件、SHA-256 は `ca30ff958ff5fbbd04e8e50b31c7c01a6319b7864b49ef8e506c3f20acc5f2ab`。Whole/Crop・Before/After・Draft/Full・Region・WB を公開するが Point Color の設定や Overlay は拡張していない。
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

## 9. History／Recipe 統合上の課題

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

## 10. GenzoRoom UI 統合方針

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
2. **Preview 専用の最小 Native 公開 patch**。Desktop と共通の `RenderJob::with_overlay` を Headless Whole から選べるようにする。Region 公開が必要になった時点で同じ Overlay を配線する。Composer や独立した描画アルゴリズムは追加しない。
3. **成立しない経路**。既存 `render_preview` の設定変更だけで同じ表示を得る方法は確認できなかった。通常 After を単純にモノクロにする方法や、全調整を書き換えて疑似表示する方法では、Desktop の選択エントリーのみを中立化して最終色から重みを再計算する処理を再現できず、永続化の境界も崩れる。

## 13. 実確認・未解決事項

**実 CLI 確認**。SHA/receipt 照合済み CLI、CPU（`LIGHTCRAFT_GPU_BACKEND=off`）、一時ディレクトリ内の合成 64×32 二色 PNG と in-memory Headless Session を使用。MCP schema と command list、空 snapshot/controls、採色値と初期値、重複採色、座標 clamp、不正座標、8 件上限、削除と index 移動、0/56 control 列挙、存在しない index の書込み no-op、clamp／小数保持、個別 Reset、Point Color Section Reset の no-op、キー省略と空配列 merge、配列 merge が 9 件・範囲外値を保持することを確認。通常 Draft/Full PNG を取得し、Full が編集前と異なること、合成素材の JPEG 出力と前後 snapshot の Point Color 一致を確認。JPEG の画素別照合は実施していない。

**未確認**。実 RAW/非RAW と EXIF・Rotate/Flip・Straighten・Crop・高倍率 Region の組合せにおける採色位置、proxy とルーペの色差、RAW の埋込 Preview/フォールバック時の採色、Desktop 範囲表示の目視と翻訳ラベル表記、DX12 と CPU の診断出力/応答性、GenzoRoom アプリでの History/Recipe/Legacy/JPEG Export を実測していない。範囲表示を既存 Headless に仮の引数で呼び出す試験は行っていない。既存単体テストは関連ソースを参照した。製品変更がないため製品テスト、ビルド、ブラウザ検証は対象外。

**残るリスク**。配列 index は移動・再利用される。古い要求が別色に作用することを revision と操作所有者で防ぐ。明示配列の不正型・長さ、旧 snapshot 省略、保存再試行、Color OFF/B&W、診断 PNG の取り違えを P1/P2 の focused 回帰対象とする。強い Grading 等により Desktop 診断と通常調整の範囲が異なる点は LightCraft v0.20.0 の挙動として扱う。

## 14. P1 以降の段階的実装案

1. **P1 — Point Color 編集と永続化**。既存 command/adaptor で配列取得、採色と削除、indexed set/reset、配列 Reset を接続。旧 snapshot 省略、復元比較、History operation、独立 Export の readback を処理。共通 Viewer と Color サブカテゴリを配線し、実 RAW・非RAW の位置確認と Undo/Redo/Jump・再オープン・保存失敗を確認する。
2. **P2 — 範囲表示**。既存 Overlay を Whole Draft/Full へ公開する最小 managed patch と実 binary 検証。表示セッションの切替、Before/通常／診断の取り違え、slider 更新、Export 分離、CPU/DX12 を確認。高倍率の描画品質が必要なら Region を同じ段階で接続する。

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
