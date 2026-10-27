# LightCraft v0.14.0 詳細補正の統合事前調査

調査日: 2026-10-27。対象: Windowsネイティブ版GenzoRoom / `feature/lightcraft-integration`。調査・設計提案のみ。AIノイズ除去、Docker、JPEG暗室は対象外。

## 1. 結論と調査条件

**10項目すべてに設定・UI・編集契約はあるが、現像効果まで実装されているのは7項目。半径、シャープの詳細、通常NRのコントラストは保存可能な未接続パラメーターである。** したがって「allowlistへ10項目追加すれば完成」ではない。

推奨は**Aを条件付き採用**。シャープ4項目のうち2項目が未接続であり、現行固定版のまま4項目すべてを有効な補正として提供する受入条件は満たせない。実装開始前に、未接続2項目を無効表示／保留するか、別途承認を得てNative現像機能を実装するかを決める。続くNRにも未接続1項目がある。Bが明らかに合理的となる条件は成立していない。本調査ではいずれも実装しない。

### 確認したソース

| 対象 | 固定情報・条件 |
|---|---|
| GenzoRoom | 調査開始HEAD `ad8e2e8debabe4e5435e29ee8cf820186acf9323`。開始時のtracked/untracked変更なし |
| LightCraft | `native/lightcraft/manifest.json` のversion `0.14.0`、upstream commit `03c88c166c054c009db2a47187d59991f6232b85` |
| 実際に読んだcheckout | `.tmp/lightcraft-0.14`。`git rev-parse HEAD`で上記commitを確認。GenzoRoom管理patch適用済みの作業ツリーであり、clean upstreamとは区別する |
| 管理patch | `native/lightcraft/patches/0002-v0.14-native-contracts.patch`。実ファイルSHA-256 `9308d0663de3e4d1f6fd65e564fb04cc7ac1c993b5c1a2aae29ef1f72b521063` はmanifestと一致。Before / Whole / Region / WB契約を持つ |
| 証拠の種類 | 実ソースと既存テストの内容を確認。スクリーンショットからの推定なし。既存の調査・計測記録は補助資料として区別 |
| 今回実行しないもの | Native build、RAWの再現像・新規benchmark、ブラウザ操作、実機目視、既存テストsuiteの再実行。文書のみの変更であり、実装の合格を主張しない |

以下の `LC:` は上記checkoutを起点とするLightCraftパス、`GR:` はGenzoRoomリポジトリ起点。行番号は調査時点の作業ツリーのもの。主要な現像式を持つ `develop/src/settings.rs`、`controls.rs`、`lib.rs`、`pipeline/src/local.rs`、`finish.rs` は管理patchの変更対象外。管理patchを含むpipeline入口、GPU render、MCP Regionは現行GenzoRoomの接続条件として読む。

「確定」はソースから確認できる事実。「推定／提案」は設計判断。「未測定」は今回の実測値がないことを意味し、既存テストが存在することと実行成功を混同しない。

今回実行した静的チェックは、registryのdetail定義が10件あること、表のcontrol ID／JSON field／数値specの抽出、pipeline/GPUのRust・WGSLに未接続3fieldの参照がないこと、checkout HEADとmanifest commit、patch実SHAとmanifest digestの一致。すべて確認できた。実画像の効果検証テストではない。文書差分には `git diff --cached --check` を適用する。

## 2. 10項目の設定仕様（確定）

正本: `LC:crates/develop/src/controls.rs:255–264` の `controls!`、`settings.rs:613–644` の `Detail` / `Default`、`lib.rs:24–30` の `DevelopSettings::for_raw`。

JSONの階層は全項目 `settings.detail`。**JSONキーはsnake_case、control IDはcamelCase**。JSON型はnumber、Rust型は全項目 `f64`。整数stepの項目も整数専用型ではない。

| 分類・日本語表示案 | LightCraft表示名 | settings JSONキー（`detail.`以下） | `develop.set` control ID | 最小 | 最大 | step | 中立／単項目・カテゴリReset既定値 | 新規RAW既定値 | 現像効果 |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| シャープ | Sharpening | `sharpen_amount` | `detail.sharpenAmount` | 0 | 150 | 1 | 0 | 40 | あり |
| 半径 | Radius | `sharpen_radius` | `detail.sharpenRadius` | 0.5 | 3 | 0.1 | 1 | 1 | **未接続** |
| シャープの詳細 | Detail | `sharpen_detail` | `detail.sharpenDetail` | 0 | 100 | 1 | 25 | 25 | **未接続** |
| マスク | Masking | `sharpen_masking` | `detail.sharpenMasking` | 0 | 100 | 1 | 0 | 0 | あり |
| ノイズ軽減 | Noise Reduction | `nr_luminance` | `detail.nrLuminance` | 0 | 100 | 1 | 0 | 0 | あり |
| 通常NRの詳細 | Detail | `nr_detail` | `detail.nrDetail` | 0 | 100 | 1 | 50 | 50 | あり |
| 通常NRのコントラスト | Contrast | `nr_contrast` | `detail.nrContrast` | 0 | 100 | 1 | 0 | 0 | **未接続** |
| カラーノイズ軽減 | Color Noise Reduction | `nr_color` | `detail.nrColor` | 0 | 100 | 1 | 0 | 25 | あり |
| カラーNRの詳細 | Detail | `nr_color_detail` | `detail.nrColorDetail` | 0 | 100 | 1 | 50 | 50 | あり |
| 滑らかさ | Smoothness | `nr_color_smoothness` | `detail.nrColorSmoothness` | 0 | 100 | 1 | 50 | 50 | あり |

表示精度は半径のみ小数1桁、他は0桁。`ControlSpec::clamp` / macro生成の `controls::set`（`controls.rs:94`、同:155付近）は値域をclampするがstepへの丸めを強制しない。stepはUI操作仕様として扱い、保存値を勝手に整数へ丸めない。

LightCraftの実UIは `LC:crates/ui-egui/src/panels/edit.rs:349–369`。シャープamountが0のとき、半径・詳細・マスクを操作不可にする。通常／カラーNRの6項目はそのUIでは常時操作可能。表示名「Detail」が3つ重なるため、GenzoRoomではシャープ／通常NR／カラーNRの小見出しと翻訳・アクセシブル名を付ける案が妥当。

### MCP、merge、get、Reset

- 全10項目を `develop.set` の `values` で編集可能。キーは表のcontrol ID。`LC:crates/engine/src/cmd/develop.rs:168–231` はregistryで存在確認し、`controls::set`へ渡す。
- `develop.merge` はsnake_caseの部分JSONをdeep mergeし、未指定値を維持する。`DevelopSettings::merged` → `keep_in_range` は全registry値をclampする（`LC:crates/develop/src/lib.rs:45–70`、`engine/src/cmd/develop.rs:256`）。例: `{"settings":{"detail":{"nr_luminance":30}}}`。control IDをJSONフィールドとして流用しない。
- `get_develop` は `develop.get`へ接続し、`detail`を含む全settingsを返す。MCPの `set_develop` は `values` を `develop.set`、`settings` を `develop.merge`へ転送する（`LC:crates/mcp/src/tools.rs:188–202,738–755`）。GenzoRoomの `_command` が使う既存コマンド経路でも操作でき、新しいMCP tool/schemaは不要。
- `develop.resetControl` はcontrol specの中立既定値、`develop.resetSection {section:"detail"}` は同カテゴリの全controlを中立値へ戻す（`engine/src/cmd/develop.rs:332–355`、`develop/src/lib.rs:150–160`）。RAW importの40／25には戻らない。
- `develop.reset` はimport look、なければcamera defaultsを復元し、processはLATESTとなる（`engine/src/cmd/develop.rs:270–301`）。RAW既定ならシャープ40／カラーNR25。個別／カテゴリResetとは意味が異なる。既存import lookがある場合は表のRAW既定値を無条件に強制しない。
- `Detail` は `#[serde(default)]`。欠落フィールドのdeserializeは中立既定値となる。部分mergeでは欠落値は現在値を保つ。新規import専用の `for_raw` と区別する。旧settingsが必ず40／25になるとはいえない。

### 詳細カテゴリの有効／無効

**LightCraftの既存機構を利用できる。GenzoRoom独自の疑似トグルは不要。** `disabled_sections` に `"detail"` を保存し、`develop.sectionEnabled {section:"detail",enabled:false}` で切り替える（`engine/src/cmd/develop.rs:357`）。`DevelopSettings::effective`（`develop/src/lib.rs:104–131`）は描画用コピーの詳細を中立化し、元の10値は保持する。

注意: NativeのDetailカテゴリは対象外のAIノイズ除去も含む。`reset_section(Detail)` は `enhance.denoise` を0にして `denoise_on=None`、`denoise_amount` もdetail OFFに従う（同:134–160）。今回AI UIを追加しなくても、Recipeに既存AI値がある場合のカテゴリReset／OFFの副作用は残る。これを隠して10値だけの独自トグルに置換しない。Resetの期待差分チェックでも `enhance` を無条件に除外するのではなく、この既知の変更だけを検証する。

## 3. 現像パイプラインと実装の充足状況

### 処理順序（確定）

CPU: effective settings → geometry決定・sourceの出力サイズへのsample → scene-linear処理（local tone、WB、defringe、spots、red-eye）→ **輝度NR → カラーNR** → log luminance／texture等の空間plane準備 → per-pixel finish内の **シャープ** を含む補正 → 出力変換。

根拠: `LC:crates/pipeline/src/lib.rs::render_cached`（:621–690）、`lin_cpu`（:551）、`local.rs::apply_nr`（:435）、`finish.rs`（:497–511）。NRは露出gain前のplaneへ適用し、finish側で露出を扱う。シャープはNR後の画像のlog luminanceを参照する。最終出力resize後のexport sharpeningとは別物。

GPUも `LC:crates/gpu/src/render.rs::linear` / `denoise`（:827–886）→ `prepare` → finish shader。`nr_params`をCPUと共有する。DX12はwgpuの実行backendであり、詳細専用の別実装ではない。

### 各パラメーターの効果

| 項目 | 実際の読み取り・処理 | CPU / DX12 |
|---|---|---|
| シャープamount | `finish.rs:235` でamount/150。log luminanceとtexture Gaussianの差分 `det` に `1.3 * clamp(det,-0.8,0.8)` とマスクを掛けてdeltaへ加算（:498–510） | 両方あり |
| 半径 | schema、registry、XMP import／保存に存在するが、pipeline/GPUの現像式に読み取りなし | 両方効果なし |
| シャープ詳細 | 同上。高周波の重み等へ未接続 | 両方効果なし |
| マスク | masking/100。`smooth(mask*0.25, mask*0.25+0.15, abs(det))` で細かな差分のシャープを抑える。amount=0なら効果なし | 両方あり |
| 輝度NR | `local.rs::nr_params`（:409）と `apply_nr`。log luminanceのself-guided filterと元との差分をblendし、RGBへ同じgainを掛ける | 両方あり |
| 通常NR詳細 | guided filterのepsilonを下げ、輝度変動をより保持。輝度NR=0なら効果なし | 両方あり |
| 通常NRコントラスト | registry・保存に存在するが `nr_params`、CPU、GPUの現像式に読み取りなし | 両方効果なし |
| カラーNR | RGB/YのchromaticityをGaussian blurしblendして元の輝度を再適用。NR量が半径とblendへ影響 | 両方あり |
| カラーNR詳細 | blendを弱めて元の色の差分を保持。カラーNR=0なら効果なし | 両方あり |
| 滑らかさ | 色blurの半径を拡大。カラーNR=0なら効果なし | 両方あり |

CPU/GPU共通のNR式: `L=nr_luminance/100`、`D=nr_detail/100`、`C=nr_color/100`、`Dc=nr_color_detail/100`、`S=nr_color_smoothness/100`、`k=detail_scale` とすると、輝度sigma=`(1+2.5L)k`、epsilon=`max((0.002+L²*0.25*(1-0.7D))*k²,1e-7)`、blend=`sqrt(L)`。色sigma=`(1.5+6C)k(1+S)`、blend=`C(1-0.5Dc)`。さらにsubpixel半径では最小sigmaと分散比によるfadeを適用し、blend補正が0.01未満なら処理しない（`local.rs:374–425`）。量が0なら対応NR自体を省略する。

シャープ用texture planeは `local.rs::plane_sigmas`（:577–585）の `max(0.0018 * px_per_long,0.6)`。**表の半径値ではない**。現在の半径スライダーを動かしてもこのsigmaは変わらない。GPUのパラメーターは `gpu/src/params.rs:185–186` のSHARPEN／SHARPEN_MASK、実式は `gpu/src/wgsl/finish.wgsl` の `F_SHARPEN` 周辺。NR kernelは `gpu/src/wgsl/map.wgsl:138,162`。

未接続判定の根拠は `sharpen_radius`、`sharpen_detail`、`nr_contrast` のRust/WGSL使用箇所の検索と、CPUの `local` / `finish`、GPUのparams / render / shaderの読み取り確認。schema・registry・XMP codec・保存テストの参照は現像処理の参照とは区別した。`pipeline/src/lib.rs:536` のNR cache keyにも `nr_contrast` は含まれない。未接続値の変更でも全settings hashは変わり得るため、画像不変でも保存・revision・Historyが動く。

### 確認したテストとその限界

| 既存テスト | 確認する内容 | この調査での扱い |
|---|---|---|
| `LC:crates/develop/src/lib.rs::tests::serde_roundtrip_default_and_edited`、`tests_process.rs` | settings roundtrip／旧processとJSON | コードを確認。各スライダーの画質効果を保証しない |
| `LC:crates/develop/src/lib.rs::tests::the_denoise_amount_is_a_slider_and_follows_the_detail_section` | Detail OFF／ResetとAI値の関係 | 対象外AIへの副作用確認に使用 |
| `LC:crates/pipeline/src/local.rs::nr_tests::luminance_nr_reduces_noise_keeps_mean` | 輝度NRが合成ノイズの分散を低下させ平均を保持 | コードを確認。実RAWの主観画質評価ではない |
| `LC:crates/pipeline/src/tests_nr_scale.rs` | 0.5～0.05倍のpreview、最小半径fade、source levelとcropのscale | :98以降の閾値を確認。全サイズで画素完全一致という試験ではない |
| `LC:crates/pipeline/src/tests_window.rs:124–190` | シャープ／NRのWhole-window比較 | 64px内側で比較し、許容差あり。境界保証とは区別 |
| `LC:crates/gpu/tests/it/equivalence.rs:112–130,238–252` | NR preview、シャープマスク、NRのCPU/GPU等価性 | GPU不在時にreturnする試験。今回DX12実行済みとは扱わない |

3つの未接続パラメーターについて画像変化を保証するテストは確認できない。設定のroundtripテストや両経路が同じ画像になるテストだけでは、双方がその値を無視する問題を検出できない。

## 4. GenzoRoom接続経路と変更範囲

### 既存実装との対応表

| 対象ファイル／主要箇所 | 現行の仕組み | 詳細カテゴリ追加時の必要変更・判断 |
|---|---|---|
| `GR:backend/raw_controls.py::CONTROLS,controls_state,validate_controls,validate_history_operation` | 既存10control。`section,key=control.split('.')` でsettingsを直接読む。sectionはlight/color限定 | 値域と既定値を追加。**control ID→JSON field対応**を明示。stateのdetail enabled、operation section許可も追加。件数上限は`len(CONTROLS)`で追随 |
| `GR:backend/lightcraft_raw.py:893::set_controls` | 受けたvaluesをそのまま `develop.set`へ送る | 正式camelCase IDならNativeへ到達する。snake_case IDを直接追加するとNativeでunknown control。キー対応のないallowlist追加では破綻 |
| 同:973 `apply_history_operation` | 単項目Reset／section toggle／section reset。全settings readbackと不変領域を検証 | controlResetのJSON field解決を追加。sectionResetの `lightなら{light,hdr}、それ以外{color,wb}` という二分岐をdetail用に拡張。detail/enhanceの既知Reset差分を検証。native resetControlにはcamelCaseを渡す |
| 同:797 `_restore`、:1052以降のrestore | Native reset→全settings merge→正規JSONの完全照合 | 基盤は再利用可能。detail値・disabled_sections・対象外値を落とさない。欠落JSONがNativeに補完される場合、完全照合は失敗し得るので互換性fixtureで確認 |
| `GR:backend/windows_raw_api.py:498–521` | allowlist検証→set_controls→全state読戻し | HTTP／MCPの新endpointは不要。詳細stateのreadbackで正常にpublishされることを確認 |
| 同:610 `_fingerprint`、:733–756 History差分生成 | 全settingsのSHA-256。差分表示用値はcontrolのsplitで直接読む | fingerprint方式変更不要。差分生成にもJSON field対応を適用。section detailを通す |
| `GR:backend/raw_recipe_store.py:72–132` | 全settingsを保存。UIにない項目も保持 | detail保存専用schemaやDB migration不要。既存のsize／depth／privacy制約は維持 |
| 同:335 `HISTORY_CONTROLS,HISTORY_SECTIONS,_history_metadata` | Historyのcontrolとsectionが固定allowlist | new control IDとdetailを追加。旧IDは維持。History形式versionを不用意に変更しない |
| `GR:frontend/src/rawApi.ts:22–53,230–246,333–339` | 10 IDのunion、section light/color、control数の厳密検証、History metadata検証 | RAW_CONTROL_IDS、sections型／検証、operation型、history section検証へ追加。Backendと同時に更新しないとresponse拒否 |
| `GR:frontend/src/RawAdjustmentControls.tsx:12–75,94–100` | basic/color bindingと二者択一のNative section mapping、共通AdjustmentSlider | detail binding、小見出し、明示的category→section mapping、翻訳／表示名／トグル／Resetを追加。既存「basic以外=color」の各分岐を直す |
| `GR:frontend/src/AdjustmentSlider.tsx:13–17`、`adjustmentFocus.ts:106–142`、`editing.ts:3–5` | sliderとfocusのIDがJPEG EditRecipe由来のAdjustmentIdに依存 | **単純再利用の障害**。RAW専用IDを許す表示／focus型へ最小限拡張し、JPEG Recipe v18のadjustmentsやversionは変更しない。既存JPEGの値をRAWの詳細へ流用しない |
| `GR:frontend/src/RawEditHistory.tsx:8–30` | control名・formattersは全IDのRecord、section表示はlight/color二択 | 新IDのlabel／precisionとdetail section表示を追加。半径の小数を維持。3種の「詳細」を識別可能にする |
| `GR:frontend/src/rawControls.ts` | latest pending patch、単一mutation owner、150ms throttle、ACK後preview | 原則再利用。詳細専用queueやtimerは追加しない。gesture→最終flushの回帰テスト対象 |
| `GR:frontend/src/rawRecipeSave.ts` | 全settings fingerprintでdirty、gesture単位History、immutable retry、Undo/Redo/Jump | 新IDの型拡張に追随。保存プロトコルやretry方式の再設計は不要 |
| `GR:frontend/src/useRawDocument.ts:307–449,502以降` | invalidate→revisionに紐付くWhole要求、gesture中Draft、終了後Full、Region失効 | 共通経路を維持。新control／Reset／Undoが同じinvalidate経路を通ることを検証。詳細専用のpreview API不要 |
| `GR:frontend/src/rawRegionAuto.ts,rawRegionPlanner.ts,rawRegionContract.json` | contextを含むwindow、validRegion、revision／viewGeneration契約 | 値の追加だけで契約変更は不要。ただし詳細フィルター最大強度でcontextが足りるかは別途画質検証 |

### 固定長・カテゴリ依存

「どこにも10固定はない」とは言えない。`rawApi.ts` はcontrolsのlengthと重複なしを `RAW_CONTROL_IDS.length` に厳密一致させる。現行リストが10件なので、Backendのみ増やすと拒否される。一方 `raw_controls.validate_controls` の一括変更数はregistry長から計算される。History操作は別の固定allowlistを持つ。UIのbinding／title／sections、History表示も2カテゴリ前提。

更新対象fixture: `frontend/src/test/rawSettings.ts`（現行の汎用min/max式では半径等を表現できない）、`test/rawHistory.ts`、関連API／control／historyのunit/integrationテスト。`backend/tests/test_raw_controls.py`、`test_raw_category_operations.py`、`test_raw_history_api.py`、`test_raw_history_store.py`、`test_raw_recipe_restore.py`、`test_lightcraft_raw.py`も変更に応じて拡張する。

データ量制限も独立にある: settings 256KiB、History 200件、History API response 256KiB（`raw_recipe_store.py:16,333`、`windows_raw_api.py:26`）。項目数を増やす際は200件の最大差分応答を試験する。既存 `test_raw_category_operations.py::test_full_history_page_with_repeated_all_reset_deltas_stays_bounded` は現在の10項目を基準としており、成功済みとみなして増加後の検証を省略しない。

### 設計提案: IDを混同しない

既存RAW APIのID体系と整合させ、表のNative control IDをRAW control IDとして使い、Backendに対応するJSON fieldを定義する案を推奨する。少なくともcontrols_state、Reset期待値、History差分生成は同じ対応を使う。別案はsnake_caseのRAW API IDを採用してNative送信時に変換することだが、保存済みHistory metadataとAPI IDの正本を追加することになる。どちらでも「splitすればJSONが読める」という現在の不変条件は崩れるため、変換を各所で推測しない。

## 5. 保存・History・既存Recipeの互換性

確定事項:

1. 現在も全settingsのdetailはNative readback、Recipe、History snapshotに入る。UIで編集できないことは保存されないことを意味しない（`raw_recipe_store.py::_settings_json` の全field保持）。今回のUI追加のためにsettings schema／DBを変える必要はない。
2. 全体fingerprintはdetail値とdisabled_sectionsも含む。revisionは `_mutate` の予約・commit、preview ticketの整合性で管理される（`lightcraft_raw.py:809以降`）。新しい項目でも同じ仕組みを使う。画像に効かない3値もsettings差分としてHistory／dirty／revisionへ影響し得る。
3. 永続Historyはコマンド再演ではなく保存settingsを復元する経路を使い、Undo/Redo/Jumpは全settingsを保持する。表示用changesだけを新10項目に置き換えない。旧control metadataを許可したままallowlistを拡張すれば旧Historyは読み得る。
4. 旧RecipeやHistoryのdetail値へ新規RAW既定値を上書きしてはならない。新規documentはNative import初期値を表示する。保存Recipeがあればrestoreを終えてからpublish／previewする現在の順序を維持する。
5. `GR:backend/tests/test_raw_recipe_restore.py::test_v010_recipe_restores_on_v014_and_next_save_uses_current_tuple` と `test_windows_opens_v010_recipe_then_saves_current_tuple` が既存互換経路を扱う。UI追加によりengine identityを変更しない。任意の過去versionを無制限に許可する提案ではない。

追加検証が必要な点:

- 既存v0.14 Recipe、サポート対象v0.10 Recipe、旧History（detail操作metadataなし）から開き、既存detail全値を保ったまま編集・save・reopen・Undo/Redo/Jumpできること。
- detail欠落／一部欠落のsettings。Nativeのserde補完とGenzoRoom `_restore` の文字列完全照合は別問題で、Nativeが読めることだけではGenzoRoom復元成功と断定できない。既存保証を保ち、安易に完全照合を緩めない。
- category OFF中の値保持、Reset、OFF→ON、Undoで値とenabledが揃うこと。allResetはimport lookへ戻し、既存のdisabled_sections保持処理を継続する。
- Detail Resetによる `enhance` 変更は既存対象外fieldの保護と両立させる。未使用AI値を消さない独自Resetを採る場合はNativeカテゴリResetとは異なる操作として別途設計判断が必要。
- 保存応答喪失、revision競合、readback不一致、compound reset失敗時rollback、generation変更、Native再生成で詳細値を保持すること。既存retry／immutable request／save fenceを再利用する。

## 6. Preview・性能・画質

### Draft / Fullとサイズ（確定）

7つの有効パラメーターはDraft／Full両方に適用される。DraftだからNR／シャープを全省略する分岐はない。CPUの `pipeline/src/lib.rs:665–674` はNR変更時のDraftに限り、同じpre-NR keyのwide planesを再利用する。log luminanceとfine textureは再計算し、Fullはその近似planeを採用しない。**GPUにはこのCPUの `for_other_nr` 近似再利用はなく**、`gpu/src/render.rs:681–691` はlin_key不一致で新しいPlanesを作る。CPU／DX12、Full／Draftが常に同じ画素結果・負荷になるという意味ではない。

NRの `detail_scale=min(px_per_long/native_long,1)` はオリジナル画素を基準とする（`pipeline/src/lib.rs:494–518`、`local.rs:374`）。小さなWholeでは半径とepsilon、subpixel blendが縮小する。`native_long` を伝えて低解像source levelと元sourceのNR尺度を揃える。100%相当ならscale=1、Fitでは小さくなることが一般的だが、crop／virtual full frameも含めて算出され、UI zoom値だけで決めない。

シャープは現在 `px_per_long` に比例するtexture Gaussianを使い、半径／詳細は無視する。Fitと100%ではsampleする情報、表示倍率、plane尺度が異なる。Fitの小画像だけでRAW等倍画質を評価しない。source resample→NRという順序なので、全解像度で現像した結果の縮小とpreviewは厳密同一ではなく、既存scaleテストも誤差上限を検証している。

### Whole / Regionと境界

確定: windowでも `px_per_long` はvirtual Whole frameから計算し、Regionの幅を新たな写真の長辺として扱わない。現行MCP RegionはFull sourceを取得してwindowをrenderする（`LC:crates/mcp/src/region.rs:247–254,324–371`）。Wholeが異なるsource level／output scaleなら、同じsettingsでも同じpixel結果とは断言できない。

既存 `tests_window.rs` のシャープ試験は最大6／平均0.8 LSB、NR試験は最大3／平均0.15 LSBを許し、**window端から64px内側だけを比較**する（:15,35–55,126–136,182–189）。これを「Region境界まで一致」の根拠にはできない。window sampling端やGaussian／guided filterの近傍不足によって端の結果が変わり得る。

GenzoRoomの自動Region policyは `rawRegionAuto.ts::REGION_AUTO_PROVISIONAL` のcontext=16、prefetch=64。plannerはcontextを除いたvalidRegionを使うが、budget-center／grid／image端で余白の条件が変わる。16pxが既存テストの64px haloと同等とは言えず、最大カラーNR（native sigmaは最大15px）、最大シャープ、両者併用をsource等倍／深いzoom／image端で比較する必要がある。prefetch=64を恒常的な保証haloとみなさない。既存contract上限はRegion 2048軸／2,097,152 pixels、Whole最大sideは2048。今回上限やcontextの変更は提案実装しない。

### 負荷・更新頻度・メモリ

| 観点 | コードから確定／推定できること | 実測状況 |
|---|---|---|
| 画素数 | 出力画素Nを走査する処理と複数のplane／RGB bufferを持つ。固定設定・固定scaleなら概ね画素数とともに処理・作業メモリが増えるという推定。正確な比例率は未確定 | 詳細単独のms/MP、MP別peak RSS／VRAMは未測定 |
| シャープ | amount／maskはfinish演算。amount有効化でtexture planeが必要。半径／詳細変更は現在現像効果なし | 有効化cold／warm時間は未測定 |
| 通常NR | log-luminance plane、guided filterと複数blur、中間plane、RGB更新。NR設定変更でlin_keyが変わり、下流planeの再計算へ波及する | amount／detail別増分は未測定 |
| カラーNR | RGB chromaticityとblurのRGB中間bufferを使う。単一channelのplaneより各bufferが大きい | 通常NRとの速度・peak memory比較は未測定 |
| Draft / Full | 共通のNR本体に加え、Draftのwide plane近似再利用と要求解像度差が負荷を変える | 詳細10項目を振ったDraft/Full比較は未測定 |
| CPU / DX12 | 有効7項目の両経路あり。GPUのbuffer pool／cache、readback、fallbackも負荷へ影響。DX12指定だけでGPU成功とみなさない | 今回の詳細補正DX12速度／VRAM／fallbackは未測定 |
| Whole / Region | Regionは出力windowの処理量を減らせるがFull RAW decodeとsource保持の費用は残る | NR追加時の差分は未測定 |
| 操作頻度 | `rawControls.ts::RAW_THROTTLE_MS=150`、latest pending patchを集約しACK後preview。処理中は直列化。preview busy時に最大1000msのdisplay courtesy。終了時に最終flush | 150msは固定FPS保証ではない。詳細補正時の実adopt頻度は未測定 |
| Native History | mutation単位にNative履歴が増える。多値一括setは1 command、10項目だから10 commandになるわけではない。`MAX_EDITS=256`、Frontend受信契約の再生成閾値200を継続 | History／再生成時の詳細追加によるpeak差分は未測定 |

Native Historyは設定データ、StageCacheは画像とplaneを保持する別の責務。設定10数値の追加量だけから総メモリを見積もらない。現在もdetail全値を保存しているため、UI追加自体で初めて10数値がNative snapshotへ現れるわけでもない。多数の操作によるmutation budget消費と、NR変更時に大きいbufferが旧新共存するリスクを分けて評価する。

### 既存ベンチマークの利用範囲

`GR:native/lightcraft/raw_preview_smoke.py` の任意 `--benchmark --raw-file` はNative/MCP/Backend計測であり、Frontend decode/adoptは含まない。Developer Diagnosticsの `rawViewerBenchmark.ts` / `RawViewerBenchmarkPanel.tsx` はViewer経路を測る既存基盤。将来の実装受入では既存方式を使い、必要なCPU／DX12、cold／warm、Whole／Regionの少数比較に絞る。

既存記録 `REGION_C3_BASELINE.md`、`REGION_C3B_PLAN_TIMING.md`、`RAW_PREVIEW_INTERACTION_PERFORMANCE.md`、`RAW_DX12_STAGE_CACHE_RESEARCH.md` はsource取得・transport・cache等の背景を示す。ただし旧engine版／当時のsettingsや環境の記録を含み、現行v0.14の詳細項目別増分benchmarkではない。記録の値を今回のシャープ／NR性能値として転記しない。新規測定は今回実施していない。

## 7. Native patchの要否

| 目標 | 判定 |
|---|---|
| 既存7項目の編集・保存・Preview、既存10値のset／merge／get | **新規Native patch不要**。既存registryとMCP契約で足りる。GenzoRoom adapter/UI/Historyの更新は必要 |
| 半径／シャープ詳細／NRコントラストにも独立した現像効果を持たせる | **Native現像側の変更が必要**。v0.14.0固定を維持するなら管理patchとしての実装・検証が必要となる。GenzoRoomのallowlist変更だけでは実現不能 |
| Detail ON/OFF／Reset | Nativeに実装済み。新規patch不要。ただしenhanceへの既存副作用を設計・検証する |
| Region境界の一致 | 現状の証拠では新規patch要否を確定できない。まずcontext／validRegion内の比較を行い、差が出る場合はadapter側余白とNativeの各境界を切り分ける |

Nativeへ未接続3値を実装するなら、CPU式だけでなくGPU params/shader、plane radius／NR key、StageCache無効化、Draft近似、Region近傍幅、旧settingsの見え方も検討が必要。現在保存されている非既定の未接続値が新たに効き始めることは画質互換性の変更となる。単にschema versionを上げる／既存Recipeを変換するだけでは解決しない。今回はpatch／manifest／binary receiptを変更しない。

## 8. A/B比較と推奨

| 比較軸 | A: シャープ4項目先行 | B: 詳細10項目一括 |
|---|---|---|
| 共通変更 | ID対応、3カテゴリ、History、Recipe、focus型の土台は初回に必要。NR追加時に再設計せず拡張可能なregistryとする | 土台の変更を1回に集約できる |
| 現行Nativeの不足 | 半径・シャープ詳細の2つ。4項目完成には先に方針決定が必要 | 左記＋NRコントラストで3つ。10項目完成とは言えない |
| Preview検証 | texture plane／finish／maskと既存NRとの相互作用が中心。RAW importでカラーNRが有効な点は無視しない | NRのlin cache失効、Draft近似、サイズfade、color中間bufferも同時に受入 |
| 互換性 | 共通保存基盤を先に少数項目で確認しやすい | 値の組合せとReset／History差分応答の検証範囲が増える |
| Nativeを補完する場合 | 2つの新しいシャープ挙動を限定してレビューできる | シャープとNRの別処理stageへ同時に変更が広がる |

**A推奨。ただし「4項目がすでに使える」という前提は修正する。** 共通settings階層だけならBに重複削減の利点はあるが、現像への接続状況とcache／Region／画質互換性の検証負荷からBが明確に優位とはならない。

実装前の選択肢は、(1) v0.14固定・patch追加なしで有効なシャープamount／maskのみを提供し、半径／詳細は保留と明示する、または (2) 4項目すべての実装を要件とし、別タスクでNative補完の仕様と互換性を先に決める、のいずれか。未接続スライダーを有効に見せる実装は推奨しない。これは今回の調査後に決める事項であり、機能スコープを本書だけで変更しない。

## 9. 実装前の未解決事項と必要な追加検証

1. **受入仕様の決定**: 未接続3値の扱い、Aの4項目要件とv0.14固定の両立方法。Native補完する場合は式・CPU/GPU・既存保存値への互換性方針を別途承認する。
2. **ID／UI型**: 正式control IDとJSON keyの対応を共通化する位置、JPEG Recipeを変えずRAW専用focus IDを扱う最小変更を確定する。半径のstep0.1／精度1、3つの詳細labelも確認。
3. **Native focused correctness**: 有効項目ごとの合成画像変化、amount=0で従属値が無効、detail OFF／ONで復帰、個別／カテゴリ／全Resetの差。CPU／実DX12、Draft／Full、cache OFF／ONで確認。CPU/GPU同士の一致だけでなく、基準画像から効果が出ることも試験する。
4. **Region画質**: 同source・同virtual full寸法のWhole cropとRegion validRegionを比較。NR最大値・シャープ最大値・併用、crop／image端／budget制限で誤差を記録。既存64px内側の試験をcontext16の保証に読み替えない。
5. **保存／History**: 旧Recipe／旧History、新規document、category OFF、Reset後save/reopen、Undo/Redo/Jump、redo分岐、応答喪失retry、rollback、再生成を関連既存fixtureで拡張。最大200件のHistory差分応答とsize制約も確認する。
6. **必要最小限の性能測定**: 代表RAWでCPU／DX12、Whole Fit／Region等倍、Draft／Fullの処理時間と実adopt頻度を既存benchmarkで確認。NR有効化前後とcold／warmを分ける。peak RSS／VRAMは未測定のまま受入判断できない場合に限定して追加する。source取得時間をNR演算時間と混同しない。
7. **手動確認**: ユーザーのWindows実機で100%／Fit、エッジ／低照度／色ノイズの見え方、Region境界、カテゴリとキーボードfocusを確認。今回ブラウザ・NAS・Firefox検証は行っていない。

今回の成果物は本書1ファイルのみ。実装、Native patch／manifest、README、CHANGELOG、architecture、development-notesは変更していない。既存stashは維持する。
