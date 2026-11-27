# LightCraft v0.20.0 キャリブレーション統合の事前調査

調査日 2026-11-27。GenzoRoomの調査基準は `29e2b34b7bc6cff350b48ca0fcedb81ac93cd6a1`。LightCraftは [固定upstream 192ff729](https://github.com/storytold/lightcraft/commit/192ff72923c39e6623f2c7ff67ab3a119deb8071) に、[manifest](../../../native/lightcraft/manifest.json) の現行 [Whole Frame managed patch](../../../native/lightcraft/patches/0001-v0.20.0-whole-frame.patch) を適用した状態を使用した。ローカルのGitオブジェクトから隔離コピーを展開し、patchのSHA-256 `a72ebfa66ce04b3aea5232b8d5a665ab8a4e0a1e2e169a8deb6286639778f974`、適用後の逆適用チェック、二重適用の拒否を確認した。Nativeのパスはこのソースを基準とする。

[AGENTS.md](../../../AGENTS.md)、[恒久統合契約](LIGHTCRAFT_INTEGRATION_CONTRACT.md)、[v0.20.0移植記録](LIGHTCRAFT_V020_UPGRADE_PLAN.md)、[Color Mixer](COLOR_MIXER_INTEGRATION.md)、[Point Color](POINT_COLOR_INTEGRATION.md)、[Effects](EFFECTS_CONTROLS_INTEGRATION.md)、[Detail／Sharpening](DETAIL_CONTROLS_INTEGRATION.md)、[Optics](RAW_OPTICS_PHASE6_VALIDATION.md) を参照した。依頼時の画像は公式GUIの項目構成と外観の参考とし、値域・操作・処理の根拠にはソースと実Nativeの応答を用いた。

## A. Native機能調査

7項目の設定型はすべて Rustの `f64`（JSON number）。Engineでは全項目が `Section::Calibration` の `ControlSpec` に登録され、範囲は **−100〜+100、刻み1、既定値0、表示小数0桁**。同じ `ControlSpec` を公式GUIとMCPの `list_controls` が参照する。設定JSONとコマンドのIDは以下の対応になる。

| 設定JSONのパス | 数値コマンドのID | GUIの項目・トラック |
| --- | --- | --- |
| `calibration.shadows_tint` | `calibration.shadowsTint` | Shadows Tint、緑→マゼンタ |
| `calibration.red_hue` | `calibration.redHue` | Red Hue、赤紫→橙 |
| `calibration.red_sat` | `calibration.redSat` | Red Saturation、灰→赤 |
| `calibration.green_hue` | `calibration.greenHue` | Green Hue、黄緑→青緑 |
| `calibration.green_sat` | `calibration.greenSat` | Green Saturation、灰→緑 |
| `calibration.blue_hue` | `calibration.blueHue` | Blue Hue、青→紫 |
| `calibration.blue_sat` | `calibration.blueSat` | Blue Saturation、灰→青 |

- **公式GUI**は編集パネル末尾に独立した開閉・目アイコン付きセクションを置き、シャドウ、赤原色、緑原色、青原色の順に縦に並べる。トラックは線形で0が中央。クリック・ドラッグ、数値欄の直接入力・左右へのスクラブ、キーとホイールの調整、ラベルまたはトラックのダブルクリックによる個別Resetを共通スライダーで扱う。ドラッグは `develop.beginInteraction → set → endInteraction` で1 Undo単位。OFFでも公式GUIは開いているセクションのスライダーを編集可能なまま表示する。根拠は `crates/ui-egui/src/panels/edit.rs:377`、`panels/edit/sliders.rs:7,183`、`widgets.rs:421`。
- **設定・readback**は、単一の `develop.set {control,value}` と複数の `{values}` で表のコマンドIDを使う。 `develop.merge {settings:{calibration:{red_hue:12.5}}}` は設定JSONを深くマージする。両経路とも有効な数値を範囲内へクランプし、刻み1への丸めは行わない。 `develop.get {id}`／MCP `get_develop` は保存状態の7値と `disabled_sections` を返す。根拠は `crates/develop/src/settings.rs:161,563`、`controls.rs:85,145,289`、`lib.rs:66`、`crates/engine/src/cmd/develop.rs:322,410`、`cmd/query.rs:177`。
- **画素処理**はシーンリニアRec.2020の共通仕上げ段。原色6値から、白を保持する3×3行列を作る。各原色のHueはOkLChでの色相回転、Satは彩度スケールを変える。6値がすべて0なら行列を省略する。続くShadows Tintは暗部ほど強く緑↔マゼンタに寄せ、輝度を保つ。正値がマゼンタ側。行列は原色帯ごとの選択的な補正ではなく、混色にも作用する。根拠は `crates/pipeline/src/colorops.rs:269–318`。
- **処理順序とColorとの関係**。WB・露出等を含むシーン側の調整とローカルトーンに続き、キャリブレーションを適用してからトーンマップと後段の `ColorOps` に進む。後段にはMixer、Point Color、Vibrance／Saturation、B&W処理、Gradingがある。キャリブレーションを先に変更すると後段が受け取る色も変わるが、後段の設定値は保持される。キャリブレーションの適用条件にはRAW／JPEG、Process版、Draft／Full、B&Wの分岐がない。ColorのOFFが戻す設定群にもCalibrationは含まれない。根拠は `crates/develop/src/lib.rs:127–152`、`crates/pipeline/src/finish.rs:310,539–568`、`colorops.rs:158–244`。
- **CPU／GPU**とも `FinishParams` で行列とTintを共有する。CPUは `finish.rs` から `colorops::calibrate` を呼ぶ。GPUは行列・有効フラグ・Tintをパラメーターに詰め、WGSL `calibrate` を同じ段に置く。RAWとJPEGはソース準備後に同じ経路を通り、通常のAfter PreviewとExportが設定を使用する。Beforeは既存の比較元の設定で描画される。根拠は `crates/gpu/src/render.rs:766`、`params.rs:328`、`wgsl/finish.wgsl:250,640`、`crates/engine/src/media/render.rs:513–552`。

### 実Nativeでの限定確認

既存のWindows用 `target-p1-sharpen/release/lightcraft-cli.exe` と隣接receiptのupstream・patch・契約番号を照合した。実測EXE SHA-256は `2e04fea8da7d84018baf7384043656af482a23986a1c63361f8200923e77eef7`。MCP handshakeはv0.20.0。隔離した一時セッションで色パッチと暗部を持つ合成Bayer DNG、upstream同梱のJPEGのコピーを使用した。

| 確認 | 結果 |
| --- | --- |
| MCPスキーマ・設定 | `list_controls(section:"calibration")` が7件のID・範囲・既定値・刻み・精度を返した。個別および一括set、部分merge、小数readback、範囲外値のクランプを確認した。 |
| Draft／FullとExport | DNG・JPEGとも7項目を個別に変更すると、両品質でデコード後RGB画素が既定値時から変化した。7項目を同時に設定した後のOFFで既定値時の画素に戻り、再ONで設定後の画素に戻った。JPEG ExportはON／OFFで画素が変わり、保存相当の完全設定をreset→mergeで復元して再ONにすると、元のON時の書き出し画素に戻った。 |
| 実行条件 | CPU固定とDX12指定の各2素材で同じ観測を得た。DX12では `app.gpu` がRadeon RX 580の利用可能・有効を返し、`lastFallback` は空。現行のWhole応答はフレーム別のCPU／GPU使用を返さないため、各Preview／Exportの実行デバイスやCPU／GPUの画素一致までは認定しない。 |
| 設定と原本 | Toggle前後のUndo／Redo、個別・Section Reset、通常のimportからの全体Reset、Colorの独立OFF、完全設定の再適用を確認した。調査用入力ファイルのハッシュは実行前後で一致し、一時セッションにXMPは生成されなかった。 |

既存Nativeテストの `crates/pipeline/src/tests.rs::calibration_shifts_colours_but_keeps_greys`、`colorops.rs` の行列・暗部Tintテスト、`crates/gpu/tests/it/equivalence.rs::gpu_matches_cpu` のCalibrationケースがアルゴリズムを検証する。今回の画素比較は入力が各境界を通ったことを確認する限定probeとして実施した。

## B. ON／OFF・Reset

| 既存契約 | 現行v0.20.0の挙動 |
| --- | --- |
| `develop.sectionEnabled {section:"calibration",enabled:false}` | `disabled_sections` に `calibration` を記録。保存された7値を保ち、描画時は行列を `None`、Tintを0にして7項目すべてをバイパスする。OFF中もNativeは値の更新・Resetを許可する。 |
| 同コマンドで `enabled:true` | 配列から `calibration` を除く。OFFにする前から値が変わっていなければ同じ補正へ戻る。OFF中に更新・Resetした場合はその時点の値を使う。 |
| `develop.resetControl {control:"calibration.redHue"}` | 指定項目を `ControlSpec.default` の0にする。ON／OFFは維持。他の6項目も同じ契約。 |
| `develop.resetSection {section:"calibration"}` | `Section::Calibration` の7項目をすべて0にする。ON／OFFと他セクションは維持。コマンドの説明文字列には `calibration` が列挙されていないが、serdeの `Section` が受理し、現行バイナリでも成功した。 |
| `develop.reset` | 写真全体をimport look／写真別初期設定と最新Processへ戻す。標準importでは7値とOFFフラグが初期化される。import lookに値やフラグがある場合はその初期状態に従う。GenzoRoomの既存 `allReset` は続けて元の `disabled_sections` 全体をmergeするため、Calibrationを追加しても従来どおり全セクションのON／OFFを保持する。 |
| History／Undo／Redo | Nativeの数値・Toggle・Resetは設定変更としてHistoryに入り、Undo／Redoが設定値とフラグを復元する。公式GUIではドラッグの一時更新を確定時に1件にまとめる。GenzoRoomでは既存のHistory操作と完全snapshotを使い、Undo／Redo／JumpはGenzoRoomのcursorとsnapshotを復元する。 |

根拠は `crates/develop/src/lib.rs:127–203`、`crates/develop/src/controls.rs:12–31`、`crates/engine/src/cmd/develop.rs:16,420,488–521,1413`、`crates/engine/src/lib.rs:805,830,984,1097`、[GenzoRoomのResetと復元](../../../backend/lightcraft_raw.py)。

## C. GenzoRoom側の不足箇所

| 層 | 実装済みの機構 | キャリブレーションの接続候補 |
| --- | --- | --- |
| Backend設定API | `/settings`、`/controls` はNative readbackを `controls_state` で公開し、リクエストのallowlist・型・有限値・範囲を確認する。UI刻みとNative値は別に扱い、APIは範囲内の小数を保持する。 | `raw_controls.py` の `CONTROLS` に7件、`CONTROL_PATHS` にcamelCase→snake_caseの対応、セクション一覧に `calibration`。 `lightcraft_raw.py` の `sectionReset` は現状の末尾がLight／Color用なのでCalibrationのreadbackを対象にした分岐が必要。既存の `develop.resetSection` を1回呼び、対象7値と既存のbypass保持を確認する。専用HTTPルートは不要。 [raw_controls.py](../../../backend/raw_controls.py) · [windows_raw_api.py](../../../backend/windows_raw_api.py) · [lightcraft_raw.py](../../../backend/lightcraft_raw.py) |
| Frontend／Preview | `AdjustmentSlider` と `beginControls → changeControls → flushControls` が通常数値編集を扱う。 `useRawDocument` が操作中のDraft、確定後のFull、revision・表示世代・古い応答の破棄を管理する。 | `rawApi.ts` のcontrol／section ID、配列件数・settings・Historyレスポンス検証を揃える。 `RawAdjustmentControls.tsx`、`adjustmentSliderIds.ts`、`appSettings.ts`、日英localeに表示・開閉・操作ラベルを追加する。グラデーションを採用する場合は `trackGradient` を利用可能。Hueは単位なしの調整量で、Gradingの角度表示用の「°」を流用しない。 [rawApi.ts](../../../frontend/src/rawApi.ts) · [RawAdjustmentControls.tsx](../../../frontend/src/RawAdjustmentControls.tsx) · [useRawDocument.ts](../../../frontend/src/useRawDocument.ts) · [AdjustmentSlider.tsx](../../../frontend/src/AdjustmentSlider.tsx) |
| History | `RawRecipeSave` が数値操作の開始時fingerprintと確定readbackを用いて、実差分があるジェスチャーを1件にまとめる。 `controlReset`、`sectionReset`、`sectionToggle` も既存operation。Windows APIは `CONTROL_PATHS` から差分を作り、保存済みsnapshotでUndo／Redo／Jumpする。 | `raw_recipe_store.py` に数値・sectionの独立したHistory metadata allowlistがあるため追加必須。 `RawEditHistory.tsx` に7項目のラベル・表示形式とセクション名を追加。数値／個別Resetは変更前→変更後、ToggleはON／OFF、Section Resetは既存規則どおり操作名で表示できる。差分計算は既存のprefix・path経路を再利用する。 [raw_recipe_store.py](../../../backend/raw_recipe_store.py) · [RawEditHistory.tsx](../../../frontend/src/RawEditHistory.tsx) · [rawRecipeSave.ts](../../../frontend/src/rawRecipeSave.ts) |
| Recipe | 完全なNative設定を保存し、reset→merge→readbackで再訪・History移動時に復元する。既存のv0.14／v0.18 Native fixtureにも `calibration` がある。UIへ未公開でも完全snapshotに含まれていれば保持される。 | 7値と `disabled_sections` の保存・再訪を既存テストで確認。実際の保存データに欠落がある場合の扱いは従来の互換性方針と合わせる。対象が見つかった場合は既存の復元・比較時の既定値補完を使い、保存済みRecipeの一括書き換えは不要。 [v0.18 fixture](../../../native/lightcraft/fixtures/develop-v0.18.json) · [Recipe復元テスト](../../../backend/tests/test_raw_recipe_restore.py) |
| Export | 独立NativeセッションでQueueの凍結Recipeをreset→mergeし、Export前後にreadbackを照合する。出力JPEGは既存の生成・登録経路を通る。 | 非ゼロ7値とOFFフラグを含む凍結Recipeを既存のfixtureに載せ、引き渡しを確認する。保存前の一時値はExportへ渡さない。Native Export呼出し、キュー、DBスキーマの変更は現時点で不要。 [raw_export_artifact.py](../../../backend/raw_export_artifact.py) · [Export契約テスト](../../../backend/tests/test_raw_export_artifact.py) |

**再利用するパターン**は、数値操作がDetailの通常スライダー、独立したToggle／Resetの表示が大カテゴリならDetail、小カテゴリならOptics（Detail内のLens Corrections）。Color Mixer／Gradingは数値・開閉・個別Resetと親子配置の参考になる。Effects内のVignetteはReset先を分けつつ親の目アイコンを共有する。CalibrationはNativeで目アイコンも独立しているため、Vignette同様にToggleを親へ結び付けるとOFF範囲が一致しない。Point Colorのインデックス管理・ターゲット操作・専用Native interactionは不要。

## D. UI設計案

| 観点 | 独立した大カテゴリ | カラー配下のサブカテゴリ |
| --- | --- | --- |
| 既存構造 | RAWの `RawCategory`、カテゴリ開閉設定とヘッダー操作を再利用。シャドウとRGB原色は見出しでまとめる。 | Mixer／Gradingの折り畳みと、Opticsの独立した目アイコン・Resetを再利用する。Colorを閉じると隠れる。 |
| ON／OFF | Native `calibration` の扱いがヘッダーだけで伝わる。Colorの目アイコンと独立。 | 親ColorがOFFでもCalibrationは有効になり得る。子の目アイコンを独立させ、親OFFのグレーアウトやdisabledを子へ継承させない。配下に見えるため、親OFFを全停止と誤認されやすい。 |
| Reset／History | Calibrationの目アイコン、個別Reset、Section Resetがそのカテゴリにまとまる。既存Color Resetは従来の範囲で使える。 | 同じHistory操作で実現できる。親のColor ResetでCalibrationまで戻すかという追加の期待が生じる。採用時も既存Color ResetとCalibration Resetを独立させる案を優先する。 |
| 画面幅と表示量 | 右ペインにヘッダー1段が増える。初期状態を折り畳みにすれば、展開前の増分はその1段。ネスト幅が不要で7行のトラックを確保しやすい。 | 大カテゴリに段は増えない。開いたColor内に7行が加わり、他のサブカテゴリとの縦スクロールが増える。子の見出し・目アイコン・Resetが幅を使うため、狭い右ペインで日英両方のラベルと数値欄を確認する。 |

**推奨は初期状態を折り畳んだ独立大カテゴリ。** NativeのColor OFF／ResetとCalibration OFF／Resetの別々の適用範囲を既存のヘッダーで表現できるため。配置と初期開閉は実装開始時に決める。GenzoRoomでのOFF中の編集は、他の通常カテゴリと同じく値を表示してスライダー入力を無効化し、共通のResetと再ONを使える案を推奨する。公式GUIのOFF中編集とは操作方針が異なるため、採用時に受入条件に含める。 [RAWカテゴリとスライダー](../../../frontend/src/RawAdjustmentControls.tsx) · [開閉設定](../../../frontend/src/appSettings.ts) · [右ペインのCSS](../../../frontend/src/style.css)

JPEG原本もWindows DesktopでLightCraft経路を通り得る。 `developmentEngine === 'jpeg'` の既存JPEG編集UIと、LightCraftでJPEG原本を開く場合は別の経路。今回のUI追加をRAW原本に限定する場合は、LightCraft側の既存アセット情報で表示を分ける。Native JPEG処理・Recipe、既存JPEG編集UIは現行経路を使う。 [AnshitsuPage.tsx](../../../frontend/src/AnshitsuPage.tsx)

## E. managed patchの要否

**キャリブレーション用managed patchの追加は不要。** Engineに7つのControlSpec、CPU／GPU処理、独立bypassとResetがある。Headless／MCPでは `list_controls`、`get_develop`、`set_develop` の値・設定オブジェクト、`command_run` の `develop.*`、既存 `render_preview`／`export` から利用できる。GenzoRoomは既存managed patchで提供済みのWhole／Region契約を引き続き利用する。命令説明の列挙漏れだけを理由にpatchを増やす必要はない。

GenzoRoom Backendは汎用の数値操作・Toggle・Reset・History・Preview・Exportを公開済みで、CalibrationのIDとSection Reset検証が未接続。Frontendの表示、操作・開閉設定、Historyラベルも未接続。UIの差分、保存、Exportへの伝搬は既存機構に載せられる。根拠は `crates/mcp/src/headless.rs:279–316`、`tools.rs:105–119,205–228,786–814,849–861,896–915` とA節の実Native応答。

## F. 推奨実装工程

| 工程・目的 | 変更対象と再利用 | テスト・完了条件 | managed patch |
| --- | --- | --- | --- |
| 1. Backendの数値・操作・保存接続 | `backend/raw_controls.py`、`lightcraft_raw.py`、`raw_recipe_store.py` と関連fixture。 `windows_raw_api.py` の既存投影・差分・操作を使い、Calibrationのための専用ルートは追加しない。Exportは既存の完全snapshot経路。 | `test_raw_controls.py` で全ID・型・範囲・path、小数readback、拒否がNative送信前に起こることを確認。 `test_raw_category_operations.py`／`test_raw_history_api.py` の既存ケースを拡張し、ON→OFF→ON、OFF状態での個別／Section Reset、Color保持、Undo／Redoと再openを1シナリオで通す。 `test_raw_export_artifact.py` の独立セッションfixtureで非ゼロ値・OFFフラグを伴う凍結Recipeの受け渡しを確認。 | 不要 |
| 2. Windows Desktop RAW UIと統合確認 | `frontend/src/rawApi.ts`、`RawAdjustmentControls.tsx`、`RawEditHistory.tsx`、`adjustmentSliderIds.ts`、`appSettings.ts`、`locales/{ja,en}.json`、必要な箇所に限り `style.css`。 `AdjustmentSlider`、`useRawDocument`、`RawRecipeSave` を再利用。 | `rawApi.test.ts`、`AnshitsuRawPreview.test.tsx`、`RawEditHistory.test.tsx` 等の既存fixture・共通テストにCalibrationを組み込む。通常ドラッグでDraft→Full／History 1件、数値入力Escapeで開始値とHistory件数を保持、既存のポインター終了規則を確認。実Nativeでは代表RAW／JPEG各1素材でPreviewとExportの設定反映を通し、Colorとの共存を1ケースで確認する。日英、狭いペイン、OFF中の操作、再訪はWindows Desktop実機で受入。 | 不要 |

共通の保存失敗・再送・履歴分岐・競合・無変更の回帰は既存テストを再利用する。新規ケースは7項目の配線、独立したToggle／Reset、設定の伝搬を対象とする。Native色演算そのものの再検証や全組合せの画素比較は工程の前提にしない。検証後に関連設計文書へ追随し、対象Backend／Frontendテスト、TypeScript、本番ビルド、`git diff --check` と差分を確認する。実装完了時はConventional CommitsでCommit・Pushし、そのCommitのGitHub上の差分をレビューする。今回の調査コミットはこの実装工程に含めない。

## G. 未確認事項

- UIの最終配置・初期開閉、グラデーション採用、OFF中に入力を許すか、LightCraftで開くJPEG原本にもパネルを出すかは実装前に確定する。既存のJPEGエンジン側の編集UIは対象外。
- 通常スライダーは数値欄のEscapeで開始値へ戻す。専用の `onCancel` を持たない通常数値スライダーでは `pointercancel` を確定扱いにする既存テストがある。ドラッグ自体の取消しを必須にする場合は、開始値の復元とHistoryなしの共通数値経路を設計し、影響する既存スライダーも確認する。現状の `pointercancel` を値の取消しとして扱う設計にはできない。 [AdjustmentSlider.tsx](../../../frontend/src/AdjustmentSlider.tsx) · [既存のジェスチャーテスト](../../../frontend/src/AnshitsuRawPreview.test.tsx)
- 完全なCalibrationが欠ける、または部分的な保存済みRecipeが実運用にあるかは未確認。固定版readbackと既存の旧版fixtureは7項目を持つ。別の互換性処理の要否は、既存の復元テストと対象データで判断する。
- 今回はソースと実CLIの限定probe。GenzoRoomの自動テストスイート、統合後のHTTP→UI→SQLite→Export Queue、実カメラRAW、Regionの個別描画、Windows Desktopの画面・キーボード操作は未実施。DX12はA節の観測範囲に限る。

## H. 今回の成果物

変更は本調査記録1ファイル。機能実装とWindows Desktopの受入確認は後続工程に残す。

## P1 Backend実装記録（2026-11-27）

この節は上記の事前調査後に行ったP1の実装と検証を記録する。UI配置、初期折り畳み、公式GUIに準じたグラデーション、既存カテゴリと同じ操作、LightCraft経由のRAW／JPEG両方への適用は確定方針であり、P2で接続する。

- `backend/raw_controls.py` に7件の数値仕様とNative設定パスを追加し、`calibration` を独立Sectionとして公開した。既存の型・有限値・範囲検証と小数readbackを使う。
- `backend/lightcraft_raw.py` は既存の `develop.sectionEnabled`、`develop.resetControl`、`develop.resetSection` を使い、Section Resetの7値とbypassを既存readback検証に含める。全体Resetのbypass保持、完全snapshotによる復元、Previewは共通経路を使う。
- `backend/raw_recipe_store.py` のHistory metadataに7 ControlとSectionを追加した。Recipe形式とDBスキーマは変更していない。Exportは凍結Recipeを既存の独立Nativeセッションに適用する。
- `backend/tests/test_lightcraft_raw.py` のNative模擬に設定とコマンドIDを追加した。`test_raw_controls.py`、`test_raw_category_operations.py`、`test_raw_export_artifact.py` で小数・拒否、独立Toggle、個別／Section／全体Reset、History、Undo／Redo／Jump、再訪、非ゼロ値とOFF状態のExport伝搬を確認した。

検証はBackendの関連テストを実行した。 `test_raw_controls.py`、`test_raw_category_operations.py`、`test_raw_history_api.py`、`test_raw_recipe_restore.py`、`test_raw_export_artifact.py`、`test_raw_recipe_store.py` の実行は440成功・1失敗。失敗したrelease Smoke TestのSQLite検証は、Windowsサンドボックスの一時ディレクトリに含まれる `#` がSQLite URIとして解釈されてファイルを開けなかった。同じテストを `#` のないworkspace内の一時ディレクトリで再実行し1成功。 `test_lightcraft_raw.py`、`test_windows_raw_api.py` とCalibration統合ケースは218成功。最終変更後のCalibration関連の重点テストは15成功。これらは模擬Nativeを使うBackend自動テストであり、上記A節の実Native調査とは別の結果である。

### P2への引継ぎ

- 現在の `frontend/src/rawApi.ts` は `RAW_CONTROL_IDS` と `RAW_SETTINGS_CONTROL_IDS` の件数・IDを厳密に照合するため、P1のBackendレスポンスを現行Frontendは拒否する。7 IDを追加し、settings検証と関連fixtureを同期する。
- `RAW_SECTION_IDS`、Toggle／Resetの型・検証、History metadataと差分のID・件数検証を同期する。`RawEditHistory.tsx` のcontrolラベル・数値書式・sectionラベルも追加する。
- `RawAdjustmentControls.tsx`、`adjustmentSliderIds.ts`、`appSettings.ts`、日英localeと必要なスタイルを、独立大カテゴリ・初期折り畳み・RAW／JPEG両対応の確定方針に沿って更新する。既存数値スライダー・操作境界を再利用する。
- P2後にBackend／Frontendの設定レスポンス、History、Recipe、Preview／Exportを一体で検証し、まとめてCommit／Pushする。P1単独ではCommit／Pushしない。

## P2 Frontend実装・統合検証（2026-11-27）

Windows DesktopのLightCraft編集パネル末尾に、初期状態で折り畳まれた独立Calibrationカテゴリを追加した。シャドウTintとRGB各原色のHue／Saturationを既存 `AdjustmentSlider` に接続し、Native ControlSpecのトラック色を使用する。カテゴリのON／OFFとResetはColorから独立する。RAWかJPEGかは拡張子で分岐せず、既存のLightCraft選択に従う。

`rawApi.ts` のControl ID、Section、History metadataとレスポンス検証、`RawEditHistory.tsx` のラベル・数値表示、`appSettings.ts` の開閉状態、日英localeを同期した。既存の数値編集、Draft／Full・Before／Region、History、RecipeとExport経路を再利用する。Native managed patch、manifest、バイナリは変更していない。

P2のFrontend対象7ファイルは648件成功。7項目のポインター・ホイール・キーボード・数値入力と個別Reset、日英表示、独立ToggleとSection Reset、既存のPreview・History・再訪などを既存テストとともに確認した。Backend対象6ファイルは441件成功。P1の検証結果とは別の実行である。TypeScriptを含むFrontend本番ビルドも成功し、既存の大きなchunkとReact Routerのモジュールdirectiveに関する警告が出た。

Backendの実際のControl定義とSection一覧をFrontend定義・Calibrationの7仕様と照合する一時テストは1件成功。トラック色の最終確認を追加した後のFrontend対象テストは5件成功した。

固定commitと現行patchのreceiptおよび実行ファイルのSHA-256を照合したNative v0.20.0に対し、実カメラDNGとJPEGのコピー各1件で、CalibrationとColorの設定・readback、Draft／Full Preview、reset→mergeでの設定復元とJPEG Exportを確認した。これはNative直接の限定確認で、Desktop画面全体やExport Queueの実機受入ではない。Windows Desktopの実画面確認はユーザー受入待ち。

P2途中のFrontend対象テストでは、既存のカテゴリ数・アクション数の固定期待値により6件が失敗した。新カテゴリを含む期待値に更新した後の上記実行は成功した。P1時のSQLite一時パス問題は、`#` を含まない一時ディレクトリで今回のBackend対象テストを実行して解消した。
