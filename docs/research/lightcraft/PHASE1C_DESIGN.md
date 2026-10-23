# RAW現像統合 Phase 1C 実装前調査・設計

本書はPhase 1Cの設計・完了記録（2026-10-22〜23、Asia/Tokyo）。**C1〜C3-D、C4-B1永続化層、C4-B2 Backend操作API、C4-B3-1保存coordinatorとC4-B3-2 RAW History UIは実装済み。C4-B3-3の統合自動検証・限定監査を完了した。実機受入の未実施範囲と完了条件は末尾のB3-3記録を参照し、C4-C以降は未実施**。初期設計と各工程の完了記録は当時の内容として保持し、現行仕様は後続記録を優先する。既存のRAW／JPEG暗室送信機能を再実装せず、その送信結果をWindows版のLightCraft RAW処理へ接続する。以下では「事実」「確定仕様」「推奨」「未決定／未検証」を区別する。

## 1. 調査基準と参照コード

| 項目 | 確認した基準 |
|---|---|
| GenzoRoom | `I:\code\genzoroom`、`feature/lightcraft-integration` |
| 開始HEAD | `8dd606711fe2cc04ecd1978bf0ccb3fb2a26c7c0`（Phase 1B完了） |
| 開始作業ツリー | clean。Fetch／Pull／Resetなし |
| LightCraft | v0.10.0、`a2a41383c4fd62fa85a46ccd00998639221f2d3c` |
| 参照worktree | `I:\code\raw-test\lightcraft-v0.10.0-gpu-poc`、HEAD一致、clean |
| 調査方法 | ローカルコード・テスト・文書の読み取り。RAW現像、GPU試験、Immich操作、ブラウザ確認なし |

LightCraft v0.11.0の調査・移行は行わない。過去のv0.9.1資料は経緯として読み、control・settings・MCPの判断には固定v0.10.0コードを使う。

主な参照（パスはリポジトリ相対、シンボル名が追跡点）：

| 領域 | コード・テスト・文書 |
|---|---|
| 既存設計 | [INTEGRATION_DESIGN](INTEGRATION_DESIGN.md)、[PHASE1A_DESIGN](PHASE1A_DESIGN.md)、[PHASE1B_DESIGN](PHASE1B_DESIGN.md)、[PHASE1C C4 native features](PHASE1C_C4_NATIVE_FEATURES.md)、[architecture](../../architecture.md)、[開発記録](../../development-notes.ja.md) |
| 送信指定 | `frontend/src/appSettings.ts`、`SettingsDialog.tsx`、`StackFormatSwitches.tsx`、`galleryAssetSelection.ts::selectGalleryAssetTargets`、`useGalleryStackSelections.ts::resolveGalleryStackSelection` |
| 展開・起動 | `GalleryPage.tsx::openWorkspaceAssets/openHomeWorkspace`、`workspaceAssetResolver.ts::resolveWorkspaceAssets`、`photoSelection.ts`、`assets.ts::WorkspaceNavigationState`、`App.tsx` |
| 暗室・写真切替 | `AnshitsuPage.tsx::activateAsset/exitToHome`、`Filmstrip.tsx`、`workspaceResume.ts`、`homeReturn.ts`、`WorkspaceLayout.tsx` |
| 表示・操作 | `ImageViewer.tsx`、`AdjustedImage.tsx`、`useJpegOriginal.ts`、`editImageSource.ts`、`AdjustmentSlider.tsx`、各AdjustmentControls、`adjustmentFocus.ts`、`editShortcuts.ts` |
| JPEG編集 | `editing.ts`、`adjustmentPipeline.ts`、`useAssetEdits.ts`、`editState.ts`、`editStateApi.ts`、`EditHistory.tsx`、`editClipboard.ts` |
| Export | `useExportQueue.ts`、`useExportRuntime.ts`、`AnshitsuPage.tsx::toggleQueue`、`backend/export_runtime.py`、`backend/main.py`、`backend/immich.py::get_asset_original` |
| RAW基盤 | `backend/lightcraft_raw.py`、`lightcraft_runtime.py`、`lightcraft_mcp.py`、`windows_local.py::LocalHost` |
| 既存テスト | `galleryAssetSelection.test.ts`、`workspaceAssetResolver.test.ts`、`GalleryStacks.test.tsx`、`appSettings.test.ts`、`AnshitsuPage.test.tsx`、`AnshitsuPersistence.test.tsx`、`useAssetEdits.test.tsx`、`Filmstrip.test.tsx`、`ImageViewer.test.tsx`、`editControls.test.tsx`、`editShortcuts.test.ts`、`AnshitsuExportQueue.test.tsx`、`useExportQueue.test.tsx`、`useExportRuntime.test.tsx` |
| Backendテスト | `backend/tests/test_lightcraft_raw.py`、`test_lightcraft_runtime.py`、`test_lightcraft_mcp.py`、`test_windows_local.py` |
| LightCraft固定ソース | `crates/develop/src/controls.rs`（CONTROLS／position／value_at）、`settings.rs`（DevelopSettings／WhiteBalance／Crop）、`crates/engine/src/cmd/develop.rs`（develop.set／merge／reset、history、interaction）、`query.rs`（memoryBudget）、`crates/mcp/src/headless.rs` |

今回テストの定義を調査したが実行していない。Phase 1A／1Bの過去の成功件数・実測値を今回の検証結果として扱わない。

## 2. Phase 1A／1Bの既存基盤（事実）

- Windows `LocalHost`だけが`LightCraftManager`と`LightCraftRawSession`を所有する。共通Backend／DockerはLightCraftを起動せず、JPEGの起動・利用可否はRAW失敗から独立している。
- Phase 1Aは常駐headless MCP、generation、要求直列化、期限、切断・明示再起動、子process／task／私有TEMP回収を実装済み。通常RPCは1 MiB、対応Preview応答だけ8 MiB。任意MCP commandをFrontendへ公開する基盤ではない。
- Phase 1Bは`open_raw(source_key, absolute_path)`、`select`、`get_settings`、`set_controls`、`merge_settings`、`restore_settings`、`request_preview`、`reset_session`、`close`、`status`を内部Python interfaceとして実装済み。HTTP API、Asset IDからRAWを取得する処理、暗室接続はない。
- `RawHandle`はsource_key／document_token／generation。PhotoIdとパスは内部。再openではtoken更新、select往復ではtoken維持。snapshotは確定readback、engine version／commit、fingerprint／content hashを持つ。
- 操作lockが選択→変更→develop.getを保護する。送信値でなくreadbackが正本。変更途中失敗はdesynchronized、切断・不正画像等はlostとして扱う。
- Previewは実行中1件＋最新待機1件。generation／document token／selection epoch／revision／sequenceを照合しstaleを破棄する。PNGは最大辺1024、最大1,048,576 pixels、encoded 5 MiB、metadata 16 KiB。CRC・IEND・Pillow完全性検査も実装済み。
- RAW保持snapshotとresidentは最大2枚、変更試行はgeneration全体で最大256回。失敗readbackも試行に含む。resetの既定はactiveを再import・復元し、非active snapshotは保持。`restore_active=False`はsnapshotを全解放する。任意枚数の外部snapshot退避・復帰APIはない。
- 最初のimportで設定する1024 MiB memoryBudgetはcache等の予算であり、process RSSのhard capではない。

Phase 1B記録のWindows内部Backend実機PoCはPASS。RAW暗室、長時間利用、Tauri表示・配布版、実GPU障害fallback、永続化、最終ExportはそのPASSに含まれない。既存の完了記録は変更しない。

## 3. 実装済みRAW／JPEG暗室送信フロー（事実）

### 3.1 指定の表現と解決

1. `AnshitsuInitialSelection`は`nonRaw | raw | both`。UI上のJPEG側を指す`nonRaw`は厳密には非RAWであり、PNG等も含む。JPEG限定へ狭めない。
2. 一般設定は`ANSHITSU_RAW_PRESETS_ENABLED=false`でRAW／両方を無効化中。保存値の読込みもnonRawへ制限する。**指定型・解決ロジックと、一般設定UIの有効化状態は別**である。
3. `StackFormatSwitches`は形式別バッジで既存memberのAsset ID集合をON／OFFできる。RAWの手動選択も存在する。`useGalleryStackSelections`はStack ID→手動Asset ID集合をsessionStorageに保持し、共有された最新の完全なStack snapshotで解決・照合する。
4. `selectGalleryAssetTargets`は完全性（UUID、primary、member数／所属／重複等）を検証し、Stack内のGenzoRoom Export素材を除外する。手動集合があればプリセットより優先し、全OFFをfallbackで覆さない。
5. 手動指定なしの場合、nonRawは非RAW全件（なければRAW全件）、rawはRAW全件（なければ非RAW全件）、bothはeligible全件。単独Assetはプリセットにかかわらず直接送る。
6. `resolveWorkspaceAssets`が各選択カードを展開し、カード選択順・member順を保持してUUID大文字小文字を正規化した重複排除を行う。不完全なStackがあれば部分Filmstripを開かずunavailable、全OFF等はemptyとなる。

StackのRAW／JPEG対応は`stackId`／`primaryAssetId`／`stackMembers`の集合関係である。1 RAW対1 JPEG、同名file、COVER＝JPEGという保証はない。RAWとJPEGを一つの編集documentに合成しない。

### 3.2 暗室への引渡しと復帰

`GalleryPage.openWorkspaceAssets`は現像対象外のguard後に既存resolverを呼び、`createWorkspaceNavigation`で`selectedAssets`／`activeAssetId`を生成し、`homeReturn`付きrouter stateで`/anshitsu/:assetId`へnavigateする。送信モード文字列を暗室で再解釈する方式ではなく、**解決済みAsset集合そのものが送信結果**である。

`AnshitsuPage`はその集合を`selectedAssets`に保持し、`excludedIds`を除いた`visibleAssets`をFilmstripへ渡す。routeのAsset IDがactive、`fetchAssetDetail`の一致したdetailだけを使用する。直接URLでもdetail取得経路があり、RAWを新しい選択ダイアログへ戻す必要はない。

FilmstripはAsset IDをkeyにサムネイル／形式バッジを並べ、activate callbackで写真を切り替える。RAWも既に一覧に載る。`supportsEditing`は現在`!is_raw && format==='JPEG'`なので、RAW表示とRAW現像対応は区別される。

JPEG切替では`activateAsset`がautosaveを停止し、cleanな保存成功まで待つ。失敗時は写真を切り替えず再試行等へ進む。RAWは現状非editableなのでこのJPEG保存処理を通らない。Phase 1Cで単にsupportsEditingをRAWまで広げるとJPEG Recipe／保存へ流れるため不可。

Gallery復帰では`exitToHome`がJPEG保存を確認し、`workspaceResume`と`homeReturn`で写真集合／active／元Gallery表示を保持する。`App`は暗室route中Homeをmountしたままにし、Stack draftを維持する。再開集合は既に展開済みなのでプリセットを再適用しない。Filmstrip除外は暗室内の状態で、元集合を破壊しない。

既存テストは手動RAW指定、単独RAW、RAW-only fallback、順序／重複、全OFF、不完全Stack拒否、写真切替保存失敗、Filmstripキー移動を扱う。Phase 1Cではこれらを回帰基準にする。新しいRAW／JPEG選択UIやモードは作らない。既存プリセットの有効化はWindowsのRAW capabilityと受入完了を条件にした既存guardの変更候補であり、最初のPreview接続に必須ではない。

## 4. 既存暗室へのRAWエンジン接続案（提案）

分岐点は暗室でactive detailを確定した直後とする。

```text
既存Gallery/Stack指定 → resolver → selectedAssets + activeAssetId → 同じ暗室/Filmstrip
  ├─ !is_raw && JPEG → useAssetEdits / useJpegOriginal → AdjustedImage → 既存WebGPU/CPU
  ├─ is_raw + Windows capability → RAW document adapter → RAW API → Phase 1B → LightCraft
  └─ その他/RAW unavailable → 既存閲覧 + 対応状況表示（JPEG現像へfallbackしない）
```

`AnshitsuPage`にRAW用hookと限定したview-modelを追加し、ready／busy／error、表示frame、dirty、reset／undo等のavailability、切替前flushを接続する。JPEG型にRAW設定を押し込まず、全暗室hookを統一する大規模改修は行わない。`useAssetEdits`は従来のJPEG条件のまま起動する。

RAW API所有者はWindows LocalHost内。共通FastAPI appへWindows限定routeを後付けするとテスト／同processの別hostへ漏れ得るため、LocalHost側に専用routerをmountし、`/api/raw`を既存`Mount('/api', backend)`より前で解決する案を推奨する。認証wrapperの内側に置き、別port、file URL、Tauri専用RAW IPCは増やさない。Dockerは専用routeを持たず、Frontendはcapabilityなしを閲覧扱いとする。

## 5. JPEG／RAW共用UIと分岐箇所（提案）

| 要素 | 分類 | Phase 1Cでの扱い |
|---|---|---|
| Gallery送信・Asset集合・形式バッジ | そのまま共用 | resolver／順序／手動指定／fallbackを維持 |
| WorkspaceLayout、左右panel、EXIF | そのまま共用 | RAW状態・エラーを既存レイアウト内に表示 |
| Filmstrip表示・移動・除外 | Adapterを介して共用 | 同じ集合とcallback。切替前にRAW readback／SQLite保存を完了し、RAW保存状態はJPEGの編集済み判定から分離 |
| Previewのpan／fit／zoom／全画面操作 | Adapterを介して共用 | ImageViewerに処理済みframe入力を追加。JPEG AdjustedImageを通さない |
| Preview pixel処理 | RAW専用 | LightCraft PNG。JPEG source decoder／renderAdjustments／WebGPUは呼ばない |
| Slider外観・数値入力・focus・begin/change/commit | Adapterを介して共用 | 基本項目の既存AdjustmentIdをUI識別子に使い、RAW controlへ明示対応。JPEG reducerは共用しない |
| WB | RAW専用の値表示・設定処理 | Kelvin／scale／AsShot。既存JPEG相対WBとは別binding |
| Before／After | Adapterを介して共用 | LightCraftのBefore render機構を使う方向。headlessでのBefore画像取得はMCP拡張の要否を別工程で判断。基準設定はC4設計で決定し、比較表示は既存ImageViewerを使う |
| Reset | Adapterを介して共用 | LightCraft標準Reset（camera/import defaults）と、SQLiteに保持するGenzoRoom編集開始baselineの復元を別操作として設計。いずれもreadback確認 |
| 編集状態表示 | Adapterを介して共用 | C3以降はRAWレシピの保存・未保存状態をRAW専用に表示し、既存永続edited／historyOnly statusへ混入させない |
| ショートカット | Adapterを介して共用 | registry・formatterと各ownerのguardを維持。Undo／Reset等だけactive engineへdispatch |
| Recipe copy/paste・カテゴリbypass | copy/pasteはPhase 1Cでは対応しない。カテゴリbypassはJPEG・RAWで維持 | JPEG個別ON/OFFは廃止し個別Resetを維持。RAW個別ON/OFFは作らず個別Resetを維持。カテゴリON/OFFはJPEG既存動作を維持し、RAWはLightCraft native `disabled_sections`を利用。Recipe／SQLite schema変更と既存データ影響はC4設計で決定 |
| History一覧 | Adapterを介して共用 | C4でRAW履歴を追加。GenzoRoom SQLiteを正本とし完全DevelopSettings snapshotとcursorを管理する。native Session Undo／Redoと履歴cursorを混在させない。JPEG History形式と分離 |
| Histogram | Phase 1Cでは対応しない（RAW初期範囲） | JPEG継続。RAWでJPEG由来の古いscopeを隠す。PNG由来scope追加は後続候補 |
| Export Queue | Phase 1Cでは対応しない（RAW） | JPEG機能維持。RAW Q／badge操作を不可とし理由表示 |
| Crop／Curve／Detail／RAW grading専用panel | Phase 1Cでは対応しない | 後続の独立UI追加。JPEG panelの大規模再構成を前提にしない |

注意：現在のImageViewerは`src`変化でfit／panを初期化する。RAWのBlob URLがframeごとに変わるだけでzoomがリセットされないよう、document identityとframe identityを分離する小変更が必要。100%は最大1024 Previewのpixelであり原本100%ではないと表示する。Before準備中は操作を無効化し、baselineを現在設定へ適用して往復renderする方式は使わない。初回baseline frameを保持・再生成する場合もdocument／snapshot一致を確認する。

## 6. DevelopSettingsと既存Slider対応表

以下のJPEG値域・初期値は`editing.ts`、意味は`adjustmentPipeline.ts`。LightCraftは固定`controls.rs`／`settings.rs`の定義。P1は最初の操作接続、P2はPhase 1C内の次段階、後続はPhase 1C対象外。**値域の一致は画質・意味・設定の互換性を示さない。JPEG Recipe→RAW DevelopSettingsの暗黙変換は一切行わない。**

| 項目 | JPEG設定・値域・意味 | LightCraft control／field・値域／単位 | 共用・優先度 |
|---|---|---|---|
| Exposure | `exposure` -5..5、step .01、初期0。sRGBをlinear化したgain（EV） | `light.exposure` -5..5 EV、step .01、初期0 | Slider adapter、P1。RAW decode後の処理とJPEG byte境界は異なる |
| Temperature | `temperature` -100..100、step1、初期0。R/B相反gainの相対補正 | `wb.temp` 2000..50000 K、step50、spec初期6500。ただしRAW matrix／scaleに依存 | RAW binding、P2。JPEG値と相互変換しない。AsShot readbackを初期値にする |
| Tint | `tint` -100..100、step1、初期0。R/B対Gの相反gain | `wb.tint` -150..150、step1、初期0。WB scale／modeと組合せ | Slider外観のみ共用、P2。値の意味は同一でない |
| Contrast | `contrast` -100..100、step1、初期0。JPEGの既存明暗変換 | `light.contrast` -100..100、step1、初期0、engine相対量 | adapter、P1。計算式／pivot／clipは共有しない |
| Highlights | `highlights` -100..100、step1、初期0。輝度依存の明部補正 | `light.highlights` -100..100、step1、初期0、engine相対量 | adapter、P1。同名の`curve.highlights`とは別 |
| Shadows | `shadows` -100..100、step1、初期0。輝度依存の暗部補正 | `light.shadows` -100..100、step1、初期0 | adapter、P1。JPEG階調重みを移植しない |
| Whites | `whites` -100..100、step1、初期0。JPEG高輝度域（開始.75） | `light.whites` -100..100、step1、初期0 | adapter、P1。RAW白点との同値性なし |
| Blacks | `blacks` -100..100、step1、初期0。JPEG暗部offset（fade終端.35） | `light.blacks` -100..100、step1、初期0 | adapter、P1。JPEG最大offset .1とは別 |
| Vibrance | `vibrance` -100..100、step1、初期0。彩度依存の補正 | `color.vibrance` -100..100、step1、初期0 | adapter、P2。同じ強度を保証しない |
| Saturation | `saturation` -100..100、step1、初期0。JPEG彩度補正 | `color.saturation` -100..100、step1、初期0 | adapter、P2。異なる色空間・stage |
| Tone Curve | 現行Recipe v18／UIにない | `curve.highlights/lights/darks/shadows` -100..100、splitShadows 10..70／splitMid 20..80／splitHighlights 30..90、points等はsettings | 専用curve UI、後続。JPEG tone sliderをcurveと扱わない |
| Sharpening | 現行Recipe／UIにない | `detail.sharpenAmount` 0..150、radius .5..3（step .1）、detail／masking 0..100 | 専用panel、後続 |
| Noise Reduction | 現行Recipe／UIにない | `detail.nrLuminance/nrDetail/nrContrast/nrColor/nrColorDetail/nrColorSmoothness` 各0..100、`enhance.denoise` 0..100 | 専用panel、後続。enhanceと通常NRは別、モデル依存を先行追加しない |
| Color Grading | `shadows/midtones/highlights`のTemperature／Tint各-100..100、初期0。JPEG輝度重み付きRGB gain | `grading.{shadows,midtones,highlights,global}.{hue,sat,lum}`＝0..360度／0..100／-100..100。blending 0..100初期50、balance -100..100初期0 | 非互換。RAW専用UIを後続へ。JPEG 3WAY値を色相／彩度へ変換しない |
| Crop／Rotation | 現行Recipe／編集UIにない。viewer pan／zoomは表示だけ | `crop.angle` -45..45度 step .01、`crop.geometry`／aspect／flip、`orientation`。`geometry.rotate` -10..10は別control | 専用geometry UI、後続。viewer変換を保存cropへ転用しない |
| その他 | JPEGカテゴリ／個別enabledはGenzoRoom独自 | texture／clarity／dehaze -100..100、mixer、profile、optics、HDR、mask等 | 後続。LightCraftに存在するだけで全controlを公開しない |

ソース上、`develop.set`でWB controlを変更するとnormalize_wb後、AsShotなら撮影時temp／tintを基にしてCustomへ移行する。これは既存LightCraftの事実であり、GenzoRoom側のWB UI接続は未実装である。AsShotへ戻す操作はbaseline復元または検証した専用WB操作で行い、数値6500の代入で代用しない。

WBの注意：`wb.scale=legacy`は省略可能で、旧相対値とKelvinの意味が異なる。RAWでもmatrixがなければ絶対Kが成立しない。静的CONTROLSのK範囲だけで全RAWをKelvinと決めない。P2前に`photo.inspect`／readbackと`develop.wb`経路から能力判定・AsShot／Custom遷移を確認し、判定不能ならWBを無効化してExposure等を使えるようにする。`merge_settings`でtemp／tintを変更する際はscale明示が必要。K trackは2000..7000が左半分、右半分が対数で50000へ至るLightCraft定義があり、JPEG線形rangeとは別adapterになる。最初は明示K数値入力＋検証済みscaleのSliderを採用し、非線形track採用はP2で決める。

## 7. Preview API・画像配信・非同期制御（提案）

### 7.1 Windows専用の最小HTTP契約

以下はC3全体の契約である。C3-Bで`POST /documents`内部のSQLiteレシピ復元、C3-Cでrecipe GET／PUTとAutosave・保存guardを接続した。同一RAW長時間編集の上限前再openはC3-Dで実装済み。workspace解放時のSession reset／cache回収は既存実装を利用する。C1／C2の既存endpointはWindows専用`/api/raw`配下であり、認証・所有確認を再利用する。C3でも原本path、PhotoId、任意commandやDevelopSettings本文をFrontend requestから受け付けない。JSONは型・件数・byte上限を検証する。

| API案 | 入出力・責務 |
|---|---|
| `GET /capabilities` | available／state／version／制限情報の安全なsubset。起動やGPU照会をGETの副作用にしない。Dockerで404ならunsupported |
| `POST /documents` | Asset ID＋workspace ID→opaque document。原本import・LightCraft content hash確認後、互換するSQLite RAWレシピがあれば復元・readbackしてからreadyを返す。UUID／Asset detailを再確認 |
| `GET /documents/{handle}` | workspaceの確定snapshot／revision／状態を取得。選択変更やimportは行わず、response消失後の再同期にも使用 |
| `POST /documents/{handle}/settings`／`POST .../controls` | C2実装済み。native DevelopSettingsのreadback／allowlist control更新。document revisionとSQLite recipe revisionは別管理 |
| `GET /documents/{handle}/recipe` | C3-C実装済み。現在documentのAsset ID／LightCraft content hash／engine tupleに一致する保存metadataを再同期。設定本文は返さず、別原本／非互換設定を適用しない |
| `PUT /documents/{handle}/recipe` | C3-C実装済み。workspace／generation／document token、expected recipe revision、saveId、confirmed document revisionだけ受け付け、Backendがnative readbackから得た完全DevelopSettingsを保存。任意設定値を受け付けない |
| `POST /documents/{handle}/preview` | expectedRevision、client selection serial／request serial、maxSide→PNG bytes＋一致確認用response headers。Supersededは204、画像なし |
| `POST /session/reset`（旧候補・必須から除外） | C3-Dは既存workspace解放・再openの再利用を優先する。汎用reset APIは追加を前提としない |
| `DELETE /workspaces/{id}` | 明示破棄／終了。要求を無効化し、Engineから参照がなくなってからowned RAW fileを回収。JPEG処理を停止しない |

SQLiteレシピ復元は`POST /documents`内部で行い、C3のために旧snapshot IDによる汎用restore APIは追加しない。C4のReset／Undo／Redoが必要とする復元境界は後続設計で別途定義する。

認証は既存LocalHostのHost／Origin／per-start cookie／bootstrap方式の内側で行う。同一origin fetch、no-store、画像responseも認証必須。CSRF対策を緩めない。opaque IDは認証の代替ではなく、現在のworkspace所有権も照合する。複数画面からの競合は初期版では単一RAW workspace ownerと409で扱い、黙って選択を奪わない。既存cookie名等の秘密はAPIやログに返さない。

エラーは固定codeへmapし、document／recipe revisionやhandle不一致は409、上限到達は明示したcapacity code、サイズ超過は413、engine unavailableは503を候補とする。HTTP statusだけで診断severityを決めない。pathやupstream本文を返さない。LightCraft mutationのresponse消失はdocument readbackで再同期し、SQLite save response消失は同じsnapshot・expected recipe revision・saveIdの完全同一requestを再送して冪等ackを得る。2種類のrevisionと復旧経路を混同しない。

### 7.2 原本の取得と所有

**事実：** `get_asset_original`と既存original endpointはJPEG限定でContent-TypeもJPEG検証する。FrontendからダウンロードしたBlobをfile pathとしてLightCraftへ渡す経路はない。

**提案：** Windows専用source providerがAsset IDからImmich detailを確認し、Backendの資格情報で原本をstream取得し、私有ローカルcacheへ保存する。既存Immich HTTP設定／例外・redaction方針を再利用するが、JPEG用関数の制限を緩めずRAW専用取得関数を追加する。RAW種別はdetail＋LightCraft inspectで再検証し、preview_onlyを編集可能としない。

cacheはFrontend指定path／URLを受理せずBackend発行名、固定local drive、拡張子allowlist、容量／timeout制限、途中fileと完成fileの分離、stream closeと失敗cleanupを持つ。原本の最大bytes・cache総量・空きdisk閾値はC1で定数とテストを確定し、無制限downloadは禁止。大きいRAWのstream hash計算と移動もevent loop外・期限付きとする。初期版は同時download 1件、activeだけの遅延取得を推奨。Immichの実保存pathを推測・共有driveで直接開く方式を前提にしない。

Backendが`workspace ID + Asset ID`とsource_keyを対応させ、cache path／fingerprint／content hash／LightCraft PhotoIdを内部管理する。退避後の再downloadではfile fingerprintが変わり得るため、Asset IDだけで旧設定を適用せず、再import後のLightCraft content hashをSQLite行と照合する。現行`restore_settings()`は元のfingerprintとcontent hashを持つ`DevelopSnapshot`を要求するため、DBから検証済みDevelopSettingsを新importへ適用する専用の`restore_persisted_settings()`経路を設ける。これは旧snapshotのfingerprint条件を緩めず、DB identity・engine/schema互換性・現在document ownershipを検証した場合だけ全設定を適用する。

### 7.3 PNGとBlob URL

Phase 1Bの検証済み`PreviewFrame.data`を`image/png` binary responseにする。Base64 JSONをFrontendへ再配信せず、file URL／data URL／公開画像directory／永続Preview cacheは追加しない。初期版はPOST responseで直接返し、期限付きPreview IDの別GET・cacheは必要になってから追加する。

response headersにgeneration／document token／revision／selection epoch／sequenceとclient要求識別子を含め、Frontendはblob読取り前とdecode後の両方で照合する。PNGには5 MiB等の既存上限を適用し、HTTP層でもContent-Type／受信bytesを検査する。`URL.createObjectURL`は受理候補だけに実行。新画像decodeと所有確認後に表示をswapし旧URLをrevokeする。拒否、decode失敗、写真切替、離脱、unmountでは候補と表示URLを両方解放する。decoded bitmapを使う場合はcloseも必要。

### 7.4 更新順序とstale防止

| 共有状態 | 所有者・更新条件・不変条件（追加案） |
|---|---|
| workspace／Asset document対応 | Backend RAW workspace。Asset IDから原本identityを確認して登録。frontend handleは現在generationだけ有効 |
| desired values／client edit serial | RAW hook。入力ごとに更新、受信readbackで未送信の新入力を上書きしない |
| confirmed settings／document revision | LightCraft readback。成功時だけ更新。PreviewとSQLite保存の入力 |
| recipe revision／saveId | SQLite RAW recipe row。JPEGと同じ楽観競合・冪等再送規約だが、LightCraft document revisionから独立 |
| selection serial | Frontend暗室owner。切替開始時に同期的に増加し、A→B→Aでも旧A結果を拒否 |
| selection epoch／sequence | 既存Backend RAW service。Frontendのserialとは別。ticket guardを維持 |
| frame／Blob URL | RAW表示hook。全identityが一致したframeのみ表示。旧document frameをloading中に残さない |
| persisted DevelopSettings | SQLite RAW専用table。C3は現在の確定レシピだけを保存。native Session再生成後はcontent hashを再確認して再適用 |
| recipeStatus／recipeRevision | C3-B Backendがdocument公開時に確定する復元元の状態。none／0またはrestored／SQLite revision。以後のC2入力が保存済みであることは意味しない |
| baseline／History cursor | C4の責務。C3のRAW recipe tableにHistory JSONやSession snapshot storeを先行追加しない |

1. Slider changeは即座にdesiredを更新。初期debounce案は100 ms（性能保証値ではない）。Preview debounceと既存Sliderの500 ms commit境界は別にする。commit時はtimerを待たず最後のdesiredをflushする。
2. Frontendの設定送信は実行中1件＋最新desired mapだけ。既存Backendはmutationsを自動集約しないので、各inputを並列PATCHしない。複数control変更は最新値を一つの許可mapにまとめる。
3. PATCHは最新confirmed revisionで送信し、readbackでその要求に対応する確定値だけ更新。送信中に増えたdesired serialは保持して次に送る。補正値を反映するのは、該当controlにそれ以降の入力がない場合。失敗はconfirmedを進めずdirty／未適用を表示する。
4. Preview要求は確定revisionにだけ送信する。Frontendも最大実行中1件＋最新必要revisionだけを保持。設定更新中の古い画像を「最新」としない。Backendの既存1＋1集約とticket guardはそのまま使う。
5. 表示直前にworkspace、Asset ID、Frontend selection serial／desired serial、generation、document token、confirmed revision、request serial、Backend epoch／sequenceを確認する。新desiredがある場合は旧revisionの結果で画面を巻き戻さない。React effect cleanupだけに依存せずrender時にもidentityで隠す。
6. 写真切替は新操作を止め、最後のdesiredをreadbackまでflushし、確定DevelopSettingsのSQLite autosave完了を確認してから既存navigateへ進む。保存失敗・競合は切替を止め、編集を保持して再試行／再同期を提示する。切替開始時に旧Preview待機をabandonし、未完了response／decodeはserial不一致で破棄する。
7. AbortControllerはHTTP待機の停止であり、送信済みMCP操作をcancelした保証ではない。HTTP切断で内部mutationを不用意にcancelするとPhase 1Bの接続無効化を招く。workspaceがbounded taskを所有し、送信済み操作は完了・readbackまで管理する。Preview待機cancelは既存ticket.abandonedを使い、実処理はworker所有のままにする。
8. 離脱時はtimer停止、serial無効化、HTTP waiter abort、URL解放。workspaceの処理をdrainし、明示release後にfileを回収する。pagehideの非同期DELETE到達を保証とせず、Backend終了／owner失効時の期限付き回収を設ける。LightCraft未回収中に原本cacheを削除しない。

### 7.5 異常終了と診断

lost／desynchronized／resettingをRAW panelへ表示し、設定操作・Undoを止める。JPEG写真は引き続き使える。LightCraft復旧は明示ボタンで行い、新generationで原本を再importしcontent hashを照合した後、互換SQLite recipeを`restore_persisted_settings()`で適用・readbackする。未確定desiredは保持・未適用表示し、自動再送せず復旧後の適用／破棄を選べるようにする。DB保存ackが不明なら同じsaveIdで照会／再送し、未保存編集が残る間は写真切替・離脱を止める。cleanup失敗ではrestart不可の既存保証を維持する。Reset（編集初期化）と復旧（Engine再起動）は別labelにする。

診断は既存frontendLogger／backend loggerを使用し、open、設定適用の失敗、世代更新、stale、容量再生成、回収・復旧の境界を選ぶ。成功の詳細・revision／sequence／timingはdebug、重要な開始／完了はinfo、復旧可能異常はwarn、必要操作の最終失敗はerror。Asset ID、世代、revision、counts／bytes、固定codeだけを採用し、path、設定本文、画像、URL、秘密、任意エラー本文を記録しない。logging失敗は操作へ影響させない。

## 8. RAW SessionとFilmstrip管理（C3-D限定見直し・2026-10-22）

### 8.1 現行実装で成立していること

調査基準はC3-C完了Commit `6a98d8ecb96d5304ad0c632c0cc9850c2e96718b`。以下はコード上の確認結果であり、新規実装要件ではない。

- `frontend/src/AnshitsuPage.tsx:activateAsset`はRAWの`prepareSave()`成功後にのみ写真を切り替える。`useRawDocument.ts:prepareSave`はdesiredのflush・readback確定・SQLite保存ack・cleanを待つ。保存失敗時は写真と編集を保持する。
- `useRawDocument.ts`はmodule単位の`ownership` queueへnative編集／保存／workspace解放／次workspace作成を直列登録する。effect cleanupは旧ownerを失効させ、送信済み処理の後ろにreleaseをenqueueする。次RAWも同じqueueで必要な原本だけを遅延importする。Filmstrip全体の枚数をnative resident枚数へ対応させる処理はない。
- `backend/windows_raw_api.py:_execute`はlockでworkspace操作を直列化し、1 workspace・1 active documentだけを公開する。`_release()`はdocumentを失効させ、`reset_session(restore_active=False)`成功確認後にcacheをcloseし、両方成功してからworkspaceをemptyにする。RAW→RAW／JPEGのたびにこの解放経路を使うため、「3枚目のresidentを追加する前だけ再生成する」設計は不要。
- `backend/lightcraft_raw.py:_reset`は既存managerのcloseと送信済み操作の回収後に新世代をstartし、readyを待ってresident・mutation試行数をクリアする。`restore_active=False`では内部photo snapshotも破棄する。既存handleはgeneration／token等で失効する。これは既に実装済みのSession再生成であり、C3-Dが作り直す対象ではない。
- `raw_source.py`は512 MiB/file、1 GiB/cache、空きdisk 1 GiB、download期限・disk I/O期限、部分file／完成file、所有directoryを管理する。書込みと容量検査は同じlock内。cleanup対象を開始時の所有resourceへ固定し、timeout後もworkerを追跡する。`_release()`失敗ではworkspace/cache所有情報とcleanup_failedを残し、新規openを拒否する。参照中原本を先に消さない既存順序を維持する。
- C3-AのSQLiteレシピとreceiptが保存の正本。C3-Bの`_restore_document()`→`lookup_raw_recipe()`→`restore_persisted_settings()`が再import後のcontent hash／engine／schema確認・全設定適用・readback一致確認を担う。C3-Cが保存と切替guardを接続済み。非active写真のメモリsnapshot storeは不要。

**実機確認済み（ユーザー報告）：** C3-CのWindows実機でRAWレシピ保存・復元が成功した。これは同一RAWの256試行超継続、長時間memory、cleanup故障時復旧の実機確認までを意味しない。

### 8.2 同一RAWの長時間編集（C3-D実装済み）

**確認済み事実：** `lightcraft_raw.py:MAX_EDITS=256`はGenzoRoomのPhase 1B PoC安全制限であり、LightCraft v0.10.0が256回で動作不能になる仕様ではない。`_mutate()`は送信前に上限確認し、native変更を試行すると`_edits`を加算する。readback失敗も数え、DBレシピ復元もこのmutation経路を使う。Sliderイベント数・成功回数・native revision・SQLite recipe revisionのどれとも同一ではない。内部`status().edits`で実試行数を取得できるが、C3-Dより前のFrontendには上限前の継続復旧処理がなかった。C3-Dはこの実カウンターを利用する。

Phase 1B調査（`PHASE1B_DESIGN.md`のnative HistoryとSession制限）と`_mutate()`のコメントは、native History／Undo・catalog／pending logの無制限蓄積を避ける目的を示す。`app.memoryBudget`はcache配分を制御するがprocess RSSや全Historyの厳密な上限ではない。**未検証：** 256という数値と実memory増加量の対応、危険になる具体的回数、同一RAWを長時間編集した場合の再生成費用。今回、新しいnative memory測定やLightCraft内部の広範囲再調査は行っていない。

| 選択肢 | 評価 |
|---|---|
| 上限だけ引き上げ／撤廃 | 少ない変更で拒否を先送りできるが、native蓄積の上界を保証せず、別の有限値でも継続問題は残る。安全とする実測根拠がないため採用しない |
| idle時間や写真枚数で常時再生成 | 写真切替は既に再生成済み。不要なrestartや新しいresident管理を増やすため採用しない |
| 同一RAWの試行予算到達前だけ保存して再open | 既存の保存・release・open・DB復元を再利用し、hard limitを保ったまま継続できる。C3-Dの推奨最小案 |

**C3-D実装済み：** 同一RAWを長時間開いた場合だけ、実`edits`予算に基づく保存済み状態からの自動再openを接続する。無制限編集のmemory安全性を実証したからではなく、現行hard limitを維持しつつ操作継続を成立させるために必要と判断する。専用の複数resident管理や汎用`/session/reset` APIは必須にしない。既存DELETE workspace→POST workspace/documentの再利用を優先する。

1. Backendは既存document/settings metadataへ`mutationAttempts`／`mutationLimit=256`／`regenerationThreshold=200`を追加した。FrontendのSlider回数やrevisionから推計しない。各native readback境界で予算を確認し、上限直前まで入力し続けてからflush不能になる構成を避ける。
2. 次patchを送る前の直列境界で新規入力を一時停止し、送信済みmutationのreadbackと最後のdesiredの確定を待つ。待機中のpatch数は既存「送信中1件＋最新未送信設定」を超えて増やさない。そのflushに必要な予算を残してsoft境界を選ぶ。soft閾値は200試行に確定した。復元・失敗も実カウンターへ含め、残り56試行を確定前flush・既存の1回のrevision再同期等の余裕とする。操作中は追加native送信をholdして最新desiredだけを更新し、commit後に最終patchをflushするため、長い連続ドラッグでも予算を使い切らない。通信／適用失敗は停止し、余裕分を無限retryへ使わない。連続ドラッグでidleが来なくても次patch送信前に停止できることを必要条件とする。
3. C3-Cと同じ確定設定の保存を完了し、結果不明requestのreplay／競合解消も済ませ、clean ackを確認する。保存失敗時には旧workspaceを解放しない。未確定desiredを保存済み扱いにせず、操作を止めて再試行可能にする。
4. 保存済みの同じAssetを対象に、既存ownership queue内で旧workspaceをreleaseし、その成功後だけ新workspaceへ再openする。古いhandle・Preview・保存応答を採用しない。hook内の同一Asset再open処理を既存queueへ接続した。新世代・保存recipe revision・全設定fingerprintの一致を確認し、旧generation/tokenを持つSlider callbackは拒否する。別の所有queueや写真snapshot storeは作らない。
5. 新importのcontent hashとengine tupleをSQLite行へ照合し、既存C3-B経路で全設定復元・readback確認後にPreviewと編集を再開する。旧ローカルfingerprintやnative PhotoIdを復元identityへ使わない。再生成中の入力は無効にし、旧document宛のpatchを蓄積しない。
6. release／cleanup失敗では所有情報を保つ既存拒否状態に従い、新workspaceを強制作成しない。再open／原本同一性／互換性／readbackの失敗では保存済みrecipeを維持し、復旧失敗を表示する。初期値で編集再開したように扱わず、明示再試行かGalleryへの安全な離脱を選べるようにする。旧process解放後も最後の確定編集はSQLiteにある。

hard limitに既に達した場合やnative結果不明の場合は、desiredを捨てて通常`prepareSave()`が成功したことにしない。まずreadback同期可能性とconfirmed保存を確認し、未確定入力が残る状態を明示する。自動再openのために失敗試行を減算したり、`MAX_EDITS`だけを上げたりしない。C4のHistory／Undo保存形式は今回変更しない。

### 8.3 高速連続切替と回収の限定判断

**確認済み：** 通常のA→B→C→Aでは、各activateAssetの保存guard、hook cleanupのrelease、次effectのopenが既存queueで順序付けられ、Backend lockとworkspace存在確認も働く。Bのopen中にCへ移った場合も、旧ownerのcurrent判定とfinallyのreleaseを経てから次queueへ進む。今回確認した通常経路に「旧cleanupが新workspaceの原本を削除する」「旧openが新documentを公開する」競合は特定できなかった。高速であることだけを理由に新しいlock・queue・generation管理層を追加しない。

**成立する失敗経路（安全側の拒否）：** releaseのHTTP失敗／timeout／cleanup失敗はhook側で`raw_release_failed`を記録してqueueを進める場合がある。Backendは旧workspaceを保持するので次createはconflict／busy等となり、新しいRAWが開けない可能性はある。これは新旧cacheを混線させる競合ではなく既存の失敗保護である。lease回収や明示cleanup再試行が成功するまでは再利用しない。C3-Dでもrelease失敗を成功と解釈せず、再試行表示と旧workspace ID保持に限定した。DELETE応答消失後の再送がworkspace conflictの場合だけ、既存capabilitiesでworkspaceState=emptyかつcleanupPending=falseを確認して先へ進む。それ以外の不明状態ではcreateを強行しない。通常切替全体の再設計はしない。

native解放、世代更新、cache所有権／cleanup worker追跡／再open拒否は既存機能として維持する。今回の限定確認では別の回収機構を必要とする不足を実証していない。独自レシピLRU・RAWメモリsnapshot store・複数native resident最適化・cache管理の再実装をC3-D必須から除外する。再downloadや再importの性能問題を実測した場合に限り、後続改善候補として別途検討する。

### 8.4 C3-Dの最小受入条件（Fake自動検証済み・実機はユーザー確認）

- 同一RAWで旧256試行を超えて編集を継続でき、soft境界前の確定readbackをSQLiteへ保存してから新世代を開く。最終値がDB・復元readback・Previewで一致する。復元や失敗試行も予算計上し、連続入力でもhard limitへ未処理desiredを押し込まない。
- 保存失敗／応答消失／競合では旧documentと未確定入力を保持し、保存確定前にreleaseしない。release失敗では新workspaceを作らず、再open／restore失敗では保存rowを維持して復旧失敗を表示し、再試行可能である。
- gate等の限定テストでrelease遅延、途中openからの連続切替、旧generationのPreview／保存応答を確認する。通常A→B→C→Aは既存保存・解放・SQLite復元で成立することを確認するだけで、3枚residentを要求しない。cleanup失敗・timeout時の所有保持とJPEG切替／通常終了保証も維持する。
- 同一RAWの再生成待ち時間と長時間memoryはWindows実機で別途確認する。fakeテストだけでGPU／process RSS回収完了や性能を保証しない。C4／RAW Exportの受入範囲を広げない。

## 9. Recipe／History／Exportとの境界

### 9.1 Recipe・写真切替・Session reset

**事実：** JPEGはRecipe v18、`useAssetEdits`のAsset別record、`editState.ts`のvalidation／migration、Backend保存revision／save ID、autosave・retry／conflictを持つ。LightCraftはDevelopSettingsのschema `version`と描画`process`が別で、さらにengine version／commitがある。

**C3設計（保存層はC3-A、document openでの復元はC3-Bで実装済み）：** C3の初回から既存SQLite DBへRAWレシピを永続化する。JPEGの`asset_edit_states`とRecipe v18／History形式は変更せず、別の`asset_raw_recipes` tableを加えた。確定した主キーは`(asset_id, source_content_hash, engine_name, engine_version, engine_commit, settings_schema_version)`。これにより同一Asset IDの原本差替えや非互換engine recipeを上書きせず保持し、Asset ID単位の取得時に現在のcontent hashと互換engine tupleで絞り込める。旧recipeの削除・自動上書き・暗黙変換はしない。暗室からの保存・Autosave・写真切替／通常終了保存guardはC3-Cで接続した。

行にはAsset ID、正規化したLightCraft content hash、engine名／version／固定commit、DevelopSettings schema version、LightCraft readbackから得た完全DevelopSettings JSON（未対応field、`process`、WB scaleを含む）、独立した`recipe_revision`、`updated_at`、`last_save_id`を保存する。handle、PhotoId、cache path、source fingerprint、認証情報は保存しない。raw content hashを同一性の根拠とし、file fingerprintは再download間で同じとは仮定しない。

`backend/edit_store.py`のSQLite接続・WAL／FULL・transaction／optimistic revisionと冪等saveId規約、`backend/storage.py`のDB検証を再利用し、C3-AでRAW tableを追加するschema migration v7を実装した。RAW CRUDはJPEGの`put_edit_state_with_recipe_change`を呼ばない。このJPEG関数はJPEG現像状態とExport Queue副作用を扱うため、RAW保存はqueue／JPEG edited判定へ作用しない独立transactionにする。Dockerも共通DB migrationで空tableを持ち得るが、Windows専用RAW API／capabilityは追加せずRAW利用可能と表示しない。

既存JPEGからは保存規約を再利用する。`useAssetEdits`／`editStateApi`のAsset別autosave、dirty/clean、revision競合、saveIdによる同一request再送、応答不明後のreplay、写真切替／離脱前にclean ackを待ち失敗時に移動を止める挙動を、最小RAW専用save coordinatorへ適用した。JPEG保存ownerは変更せず、saveId生成helperと保存規約を再利用する。JPEG／RAW adapterは別のsnapshot validator・serializer・API・tableを保ち、JPEG Recipe v18、`EditStateSnapshot`、History本文をRAWへcastしない。保存失敗／競合時に新しいsnapshotへすり替えてsaveIdを再利用しない。

RAWは`confirmed` readbackだけをautosave対象とし、desired／in-flight値を確定値として保存しない。RAWごとにAsset ID／hash／engine tupleのrecordをloadし、A→B→C→A、RAW→JPEG→RAW、Gallery再入場、アプリ再起動のいずれもSQLiteから復元する。画面終了時はJPEG同様にflush＋save ackを待ち、失敗時は画面遷移／終了を止めて再試行可能にする。SQLiteは現在のrecipe一件を保持し、C3ではHistory・履歴容量管理・Undo snapshotを保存しない。

保存は`expected recipe_revision`と`saveId`を使い、同revisionで受け取った完全同一saveId／payloadだけをidempotent replayとしてackする。response消失時は同じsnapshotとsaveIdを再送する。revision conflictでは既存DB行を読み直し、未保存の確定readbackを捨てたり、古い値で上書きしたりせず明示的な再同期／再試行へ進む。LightCraft document revisionとSQLite recipe revisionは別のversion空間である。process設定はDevelopSettings payloadに保持するが、JPEGの処理versionとは独立させる。

**新規importへの復元経路：** 原本をimportしてLightCraft `photo.inspect`から現在のcontent hashを得る→Asset ID／hash／engine名・version・commit／settings schema versionで互換rowを検索→互換性・payload上限・設定shapeを検証→専用`restore_persisted_settings()`へ全DevelopSettingsを適用→LightCraft readbackを保存payloadと照合→一致確認後にdocument readyとPreview要求を許可する。現行`restore_settings()`のprivate snapshot fingerprint条件は変えず、SQLiteからの検証済み復元を別経路にする。readback失敗・engine/schema非互換・content hash不一致では保存rowを保持し、成功復元や初期値復元と表示しない。

同一Asset IDでcontent hashが異なる場合は、旧rowを残して新原本へ適用しない。非互換engine/schema rowも保持し、C3はv0.10.0固定tupleだけを自動復元する。推奨UI状態は`none / restored / source_mismatch / engine_incompatible / restore_failed`。source／engine不一致時は明示状態で現原本の編集継続可否を示し、現原本に新recipeを保存する際も別identity rowを作成する。破壊的な置換や古いrowの清掃は別途明示操作・後続設計とする。

### 9.2 History／Undo／Redo

**事実：** JPEGは`begin/change/commit`でbefore／after Recipeを一履歴にまとめ、cursorとpendingを管理する。Sliderのpointer・wheel・keyboard・numberの確定境界を持つ。LightCraftにはnative History／Session Undoと`develop.beginInteraction/endInteraction/cancelInteraction`があるが、Phase 1Bは公開せず、各変更がnative履歴を増やし得る。

**提案：** C4ではGenzoRoomがRAW専用before／after snapshotとcursorを管理する。C3のSQLite RAW tableはcurrent DevelopSettings recipeだけを永続化し、Historyの形式・保持範囲はC4で確定する。既存SliderのonBegin／onCommitを使い、途中Previewの変更回数をUI History件数にしない。commit後に最終readbackを待って1件を確定し、値不変なら追加しない。失敗／lostでは未確定操作を確定履歴へ入れない。

Undo／RedoはRAW snapshot IDのrestore→readback成功後にcursorを更新し、新変更でredo枝を切る。C3からのcurrent recipe autosaveと履歴操作を混同せず、C4で選んだUndo／Redo結果も確定readback後にcurrent recipeとして保存する。native History cursorやSession全体UndoをJPEG shortcutへ直結しない。Undo自体も現行mutation試行を消費するため容量再生成の対象に含める。履歴の永続保持、clear／trim、clipboardはC4以後に必要性を判断する。初期C1／C2で未対応のUndoは明示無効、C4で操作体系を完成する。

### 9.3 Export Queue

**事実：** 現行Queue登録は非defaultの保存済みJPEG Recipeを前提とし、暗室ではdirtyをsaveしてからenqueueする。Backend Export runtimeも`format=='JPEG' && !is_raw`を検証し、JPEG原本取得→JpegRenderer→JPEG artifact→Immich登録へ進む。停止／再試行／登録済みAsset再利用、Stack／COVER／Album整合は既存の責務である。

**提案：** Phase 1CのRAWはenqueue不可。PNG PreviewをExport artifactに転用せず、JPEG用Recipe保存やQueue適格性を偽装しない。JPEG Queue・管理画面は維持する。

後続RAW Exportの境界は、確定したengine付きsnapshotと原本identityをjob開始時に固定し、RAW render workerがfull resolutionのsRGB出力を生成する位置。Previewと同じ設定・processを使い、previewOnly／1024 PNG制限とは分離する。Immich upload以降は既存artifact／登録・retry・Stack追加／COVER更新／Album正規化の流れを再利用する候補で、RAWのfile出力／metadata／ICC／画素寸法／orientation、登録の冪等性、再起動復旧の契約を先に定義する。Album所属履歴を新規保存せず、操作時のImmichを正本とする。これらのschema／Queue変更やImmich書込みはPhase 1Cで先行実装しない。

## 10. Phase 1Cの実装工程（提案）

各工程は別途実装指示を受けて開始する。新規候補名は確定ファイルではない。C1で既存送信→RAW Previewを最優先し、C2以降で編集・切替を接続する。

| 工程 | 実装範囲・変更予定ファイル | 既存機能への影響 | 自動テスト計画 | Windows実機受入条件・依存 |
|---|---|---|---|---|
| C1: 既存送信→Preview | 新`backend/windows_raw_api.py`／`raw_source.py`、`windows_local.py`、RAW専用Immich取得追加、`frontend/src/rawApi.ts`／`useRawDocument.ts`、`AnshitsuPage.tsx`、`ImageViewer.tsx`、必要な翻訳 | 既存resolver／形式選択は変更不要。JPEG source・処理は維持。RAW時のcapabilityとbinary frame分岐のみ | 偽Immich stream→file→fake RAW session→PNG API、認証・path拒否・size／timeout／cleanup、Frontend RAW分岐・stale表示・URL破棄、JPEG非呼出し回帰 | 既存バッジでRAW指定→暗室内にLightCraft Preview。JPEG／混在Filmstrip順序維持。API未設定でもJPEG利用可。最初は2枚制限内。前提: 1B |
| C2: Slider接続 | `useRawDocument.ts`、新`RawAdjustmentControls.tsx`、既存Sliderの必要最小adapter、API controls、RAW hook state | P1基本6項目→P2 WB／色。JPEG reducerと設定値は変更しない。copy／bypass等はRAW無効 | gate付きPATCH中連続desired、readback補正、revision衝突、commit flush、古いPreview、WB mode／scaleを検証 | 入力停止後に最後の設定のPreview。Slider数値とreadback一致。WBは能力判定したRAWだけ。前提: C1 |
| C3: 永続Recipe・Filmstrip・容量 | `backend/edit_store.py`／`storage.py`（additive v7 RAW table）、Windows RAW recipe API、`lightcraft_raw.py`の検証済みDB復元、RAW autosave adapter／RAW専用save coordinator、`useRawDocument.ts`／暗室切替・復帰、source cache | JPEG `asset_edit_states`／Recipe v18／Queueは変更せず、SQLite保存規約と切替guardを再利用。C3-A〜C実装済み。C3-D実装済み。同一RAWの200試行境界で保存・再openに限定 | migration v1–v6、RAW row／engine/hash分離、revision/saveId replay/conflict、confirmedのみ保存、再import異fingerprint同hash復元、mismatch／非互換保持、切替・restart復元、既存解放経路でA→B→C→A、同一RAWの256超試行継続、cleanup | 3枚以上巡回・多数変更で保存値保持、原本／engine変更で誤適用しない、DB保存失敗で編集を保ち遷移拒否、JPEG edited／Queue不変。前提: C2 |
| C4: 操作整合 | RAW History／baseline Before／Reset／ON/OFF、`EditHistory.tsx`のview adapter、`ImageViewer.tsx`、`AnshitsuPage.tsx`、既存shortcut registry | JPEG Undo／保存／Queueを維持。C3 SQLiteはcurrent RAW recipeを維持し、C4の履歴操作結果もreadback後autosave。Beforeは同engineのbaseline | gesture単位、Undo／Redo／枝切りと復元・保存失敗、Before frame identity、zoom維持、キーguard、切替失敗、close／復帰、RAW Queue不可 | JPEG/RAW混在で操作がactive engineだけに作用、Gallery復帰・再起動でcurrent RAW recipe復元、保存失敗で編集と再試行を保持。前提: C3 |
| C5: 完了確認 | 変更diffと影響境界レビュー、focused回帰、必要な設計文書追随 | Windows RAW追加とDocker JPEG維持の確認 | 関連Frontend unit／integration、TS check／production build、関連Backend（repo Python3.14・cwd backend）、git diff --check。全suiteはfocusedで不足する理由がある場合のみ | ユーザーによるWindows/Tauri・WebView2実画面、長時間・終了・復旧、既存Docker JPEG/NAS/Firefox確認。実施していない項目は未検証として明示。前提: C1–C4 |

C1だけで「RAWを編集できるPhase 1C完了」としない。C2–C4の設定・SQLiteレシピ永続化・切替・Session容量・History操作を含むことが推奨完了範囲。最終Export、高解像度Preview、エンジン統合、LightCraft更新、専用Rust Adapterは後続へ残す。

## 11. テストと受入条件

本調査ではコード／テストを変更せず、自動テスト・build・実機確認は行わない。文書差分と`git diff --check`を今回の検証とする。以下は実装時の計画である。

- 送信回帰：`galleryAssetSelection`／`workspaceAssetResolver`／`GalleryStacks`で手動RAW・両方・非RAW、単独、RAW-only fallback、Export素材除外、全OFF、不完全snapshot、member複数、順序・重複、再開時に再展開しないことを保持する。
- API境界：LocalHost認証／Origin／Host、Docker route不在、偽handle・別workspace・旧generation、request body上限、原本stream失敗・cancel・サイズ超過、JSONへのpath混入なし、原本／sidecarを変更しないこと。
- 非同期：fake clock／gateでdesired変更、PATCH response消失、readback補正、A→B→A、decode中切替、離脱、reopen、reset、worker失敗を再現。送信中最大1、待機最新のみ、古い画像ゼロ、URLとtask解放を検証する。HTTP abortとMCP中断を混同しない。
- SQLite／Recipe：v1–v6からのadditive migration、RAW/JPEG table分離、原本hash・engine tuple分離、confirmed readbackのみ保存、revision/saveId replay/conflict、DB busy/full時の保持と遷移拒否、JPEG edited flag／Queue不変。
- 復元／Session：異なるlocal fingerprintで同一content hashの再import、source／engine/schema mismatch、readback失敗時の保存row保持、Gallery／restart復元、3枚以上／256超試行／generation再生成、cleanup失敗時の原本保護。native memoryの完全解放はfakeテストだけで保証しない。
- 編集：Slider gesture・数値入力・keyboardの確定単位、Undo／Redo復元失敗時cursor維持、Resetのbaseline、Before中も設定不変、JPEG clipboard拒否、RAWのScope／Queue無効化、JPEG autosave／conflict／Queueの回帰。
- 実機：Windowsの既存送信操作から同一暗室にRAW Preview、代表RAWでWB／基本補正、混在写真切替とGallery復帰、zoom保持、1024制限表示、Engine終了から明示復旧、長時間操作・正常終了のprocess／TEMP回収。色管理はWebView2でsRGB／orientationを確認し、JPEGとの同値画質を合格条件にしない。
- Docker正式版：RAW capabilityがなくてもJPEG編集・保存・Queue／Exportに変更がないことを関連自動回帰で確認する。フルDocker release Smoke Testは通常開発では行わない。runtime依存／storage／startupを変える実装になった場合は`release/smoke-test.sh`への影響を再評価する。

実機・NAS／Firefox検証はユーザーの実施領域であり、今回実施済みとは報告しない。実装時もブラウザ動的確認は明示指示がある場合に限る。

## 12. 未決定事項・後続Phaseへの引継ぎ

| 判断時期 | 未決定／未検証 | 推奨判断基準 |
|---|---|---|
| C1前 | 原本bytes／disk budget／download期限・安全な拡張子、HTTP header名称／エラーschema | 無制限を許さず、代表的RAWを拒否しすぎない値と境界テストを実装時に確定 |
| C2 WB前 | matrixなしRAWの能力判定、AsShot／Customの正確な遷移、K track | 固定v0.10.0のinspect／WB commandを追加確認。判定不能ならWBだけ無効化 |
| C3-A〜Cで確定／後続 | RAW table・複合主キー／hash正規化／JSON上限はC3-A、互換性確認・readback復元はC3-B、保存・Autosave／切替guardはC3-C記録で確定。詳細な不一致復旧UIは後続 | Asset ID＋hash＋engine tupleを一意にし旧行を保持。document openはreadback一致まで公開せず、追加編集はSQLite保存ackまで未保存とする |
| C3実装前 | C2 confirmed settingsのcanonical serialization、LightCraft `photo.inspect` hashの正規化、WB scale／processの全field保持 | v0.10.0の実fixtureでserialize→restore→readback一致を確認。local fingerprintをDB identityに含めない |
| C3-D実装で確定／実機受入 | 実試行数metadata、200 soft／256 hard、操作中hold、commit後flush・保存・再openと失敗時retryは確定。実機待ち時間／長時間memoryは未検証 | §8の既存保存・release・open・DB復元を再利用。残56試行と送信直列化で最終flush予算を保持。resident／LRU／idle管理は新設しない |
| C4前 | Historyの操作境界・保持形式、Before baselineの再取得、WebView2色管理 | C3 current recipeとは分離し、Undo／Redo結果だけを確定後にcurrent recipeへ保存 |
| 後続 | RAW full-size sRGB Export、metadata、Immich／Stack／COVER／Album | job snapshot固定と登録冪等性を定義し、既存不変条件を維持 |
| 後続 | Curve、Crop、Detail、grading、bypass、clipboard、scope、高解像度Preview | engineの意味に合う個別UI／テストを追加。JPEGの同名値を変換しない |
| 後続 | PyInstaller／Job Object／Tauri実機、実GPU障害fallback、Rust Adapter | 既存未検証範囲を引継ぐ。Phase 1Cで成功を推測しない |

この設計は既存の暗室送信を維持し、Windows専用APIとRAW document adapterを追加する最小接続を推奨する。実装開始・LightCraft更新・RAW現像試験は本調査の範囲外である。

## Phase 1C-C1実装結果（2026-10-22）

本節は設計Commit `c912146f22c0f34fb5ea6d5364044c4fedd06c16`時点の本文を保持したまま追加するC1実装記録である。Phase 1C全体の完了やWindows実画面での受入完了を意味しない。LightCraftはv0.10.0／固定commitのまま。本体・v0.11.0は変更していない。

### 実装した経路

既存のGallery／Stack素材指定→解決済みAsset集合→同じ暗室／Filmstripを維持した。`useRawDocument`がRAWのactive detailだけを対象にcapabilityを取得し、Windows専用`RawPreviewApi`でworkspace作成→Asset IDから原本取得→Phase 1B `open_raw`→`request_preview`→LightCraft `render_preview`のPNG応答へ進む。FrontendはJPEGのAdjustedImageやCPU／WebGPUへRAWを渡さず、検証・decodeしたBlob URLをImageViewerの通常画像表示へ渡す。RAW中はJPEG GPU初期化も停止し、JPEGへ戻ると従来経路へ復帰する。

RAW現像PreviewにはLightCraft・最大1024pxという状態表示を付け、100%を「プレビュー100%」と表示する。capabilityなし（Dockerの404／Windows disabled等）では明示した「Immich閲覧用Preview」として従来画像を表示する。capability取得後に原本取得・現像・decode等が失敗した場合は画像を表示せずエラーを示す。閲覧用Previewを現像成功へ置き換えない。RAWのSlider／Before／History／Recipe／Exportは未実装・利用不可で、既存JPEG機能は維持する。

### C1の実API

全endpointはWindows LocalHostの`/api/raw` mountにあり、既存Host／Origin／cookie認証・no-store保護の内側である。共通FastAPI app／Dockerにrouteは追加していない。

| Method・path（prefix省略） | 契約 |
|---|---|
| `GET /capabilities` | available／state／version／maxSide／maxImageBytes。起動・GPU照会の副作用なし |
| `POST /workspaces` | 空JSON→Backend発行workspaceId。単一owner、競合409 |
| `POST /documents` | workspaceId＋Asset UUID→opaque handle／Asset ID／generation／documentToken／revision／workspaceId |
| `GET /documents/{handle}` | `X-Raw-Workspace`で所有権確認し、document metadataと現在stateを取得。設定変更・importなし |
| `POST /documents/{handle}/preview` | workspaceId／generation／documentToken／revision／serial→検証済みPNG。Supersededは204。`X-Raw-{Generation,Token,Revision,Epoch,Sequence,Serial,Width,Height}`で画像identityを返す |
| `DELETE /workspaces/{workspaceId}` | owned操作完了を待ち、RAW session reset後に原本cacheを解放 |
| `DELETE /documents/{handle}` | `X-Raw-Workspace`で確認し、そのC1 workspaceごと解放 |

raw request JSONは4 KiB、読取り5秒。FrontendのJSON読取りも4 KiB、PNG読取りは5 MiB。opaque handle／別workspace／旧generation／不一致revisionを拒否し、400／409／413／503等と固定codeで応答する。path、PhotoId、任意MCP commandや更新APIを公開していない。metadataのみを返しDevelopSettings本文はC1ではFrontendへ配信しない。

### 原本cache・期限・所有

`backend/raw_source.py`は既存Immich接続設定・認証・HTTP request方針を再利用する独立RAW取得層。JPEG限定`get_asset_original`の条件は変更していない。Asset detailのUUID／RAW種別／許可formatを確認し、原本GETを64 KiB chunkでBackend私有TEMP内の固定local driveへ保存する。拡張子は許可されたRAW formatから生成し、Asset filenameやFrontend pathを使わない。`.part`を最後に完成fileへrenameし、Photo inspectがRAWかつpreview_onlyなしであることをPhase 1Bが再確認する。原本・sidecar・Immichライブラリへの書込みAPIは呼ばない。

| 初期制限 | 値・意味 |
|---|---|
| RAW原本 | 最大512 MiB／file、宣言Content-Lengthと実受信byte両方を検査。空・truncatedを拒否 |
| cache | 最大1 GiB／workspace。C1はactive RAW 1枚だけを保持するため、通常は512 MiB以内 |
| disk空き容量 | chunk書込み後に1 GiBを残せない場合は停止 |
| 全download | detail／stream／disk処理を含め120秒。既存Immich接続3秒／通信5秒も適用 |
| 個別disk I/O | 5秒、daemon workerとcache lockで所有を保持。timeoutしたthreadを停止したとはみなさない |
| 操作 | HTTP所有task最大2件、実操作はlockで直列化。Frontendの所有変更も直列化 |
| workspace lease | 最終要求から180秒、15秒刻みで失効確認。表示中は30秒ごとの状態取得で更新 |

512 MiBは既存Pixel／Pentax DNGを想定した保守的な初期値で、全cameraへの対応や実download成功を保証するものではない。容量超過時は固定codeで拒否し、無制限に並べない。未完了downloadの部分fileも同じcache ownerが保持し、失敗／解放／shutdownで回収する。Engine importの部分成功もあり得るため、原本削除はnative参照解放後に限る。回収不能なprocessやdisk workerがある場合はcache所有権を保持し、新workspaceで上書きしない。強制終了で残った過去directoryを起動時に広く探索・削除する処理はない。

HTTP waiterのcancelはBackend所有taskをcancelしない。shutdownではdownloadだけを個別cancelでき、送信済みMCP import／renderはPhase 1Bのclose・pending解放・process回収へ委ねる。lease失効／明示解放もnative参照解放後にcacheを回収する。TEMP I/Oの実OS停止や任意の全競合は未検証。

### 設計との差分・C2以降

- C1は1 active document／workspace。写真切替・離脱で旧workspaceを解放し、次RAWを新workspaceで開く。解放は`reset_session(restore_active=False)`を使うためEngine世代が変わり、RAW往復時は再download／再importになる。既存の2枚／256試行制限を撤廃せず、C3の多数写真snapshot store／evictionを先行実装しない。
- workspaceを明示作成するAPIを追加し、import中に画面が離れた場合でも既知のownerを解放できるようにした。request到達後にresponseを失ったownerはleaseで回収する。Frontendはimportを途中abortせず結果を待ってからreleaseする。
- raw document metadataのみを保持・配信し、control更新／select／restore／明示Engine復旧APIは実装していない。異常終了時は明示エラーまたはunavailable表示とし、JPEG利用は継続できる。RAW再試行は写真の開き直し、Engineが復帰しない場合はアプリ再起動が必要。
- `ImageViewer`にdocument identityを追加。Blob URLだけが変わる同じdocumentではpan／zoomを維持し、新documentではfitへ戻る。状態表示はviewport内overlayとし既存gridの行構成を変えない。
- Frontendは受信header・PNG上限／signature・decode寸法、decode後のBackend状態を照合し、Asset ID／serial／generation／token／revisionが一致した候補だけ表示する。離脱・pagehide・失敗でBlob URLを解放。bfcacheで戻った場合も解放済み画像を現像成功として残さない。
- JPEG Recipe v18／History／Autosave／Queue、Gallery送信resolver／プリセットguard／Stack素材選択は変更していない。RAWパラメータ操作・Undo／Redo・永続保存・最終ExportはC1対象外。

### 検証方法と限界

Backendテストは本物のPhase 1B adapter＋fake MCP childを用い、`render_preview`呼出し回数とPNG bytes／headerの一致を確認する。単に画像が表示されたというassertionだけではない。sourceテストはMockTransport／fake streamで認証付き原本GET、RAW種別、上限、disk空き、timeout、途中失敗、cleanupを確認する。認証／Origin／Host、Docker route不在、handle所有・旧generation、HTTP cancel中renderとsource保持、shutdown／native回収失敗も扱う。

FrontendではRAW／JPEG混在Filmstripの既存順序、RAW中にJPEG rendererを使わないこと、capabilityなしと現像失敗の表示差、stale HTTP／decode結果の破棄、URL解放、pagehide、同documentのzoom保持、新documentのfit復帰を確認する。関連する既存JPEG保存／Queue・Gallery送信・shortcutテストも回帰対象とした。実行件数・結果は同日の開発記録に記載する。

未実施：実Immichの原本download、実LightCraftのRAW現像／GPU試験、Windows/Tauri/WebView2実画面、実色管理、NAS／Firefox、PyInstaller、実GPU障害fallback、長時間運用、正式コード監査。**C1実装と自動テストは実画面の受入完了を意味しない。** 実画面では既存RAW素材指定→暗室内のLightCraft表示、最大1024px／プレビュー100%、混在Filmstrip切替、失敗表示、正常終了・cache回収を別工程で確認する。

## C1限定監査 Medium修正：cache cleanupと再openの競合（2026-10-22）

監査対象・修正前HEADは`deec7121795cd1b220e8313ba3624d99fee09c9e`、`feature/lightcraft-integration`、開始時の作業ツリーはclean。限定監査の結果はHigh 0／Medium 1／Low 0。既存のC1設計・実装記録は上記のまま保持する。今回の修正はこのMedium 1件に限定し、LightCraft v0.10.0・Phase 1A／1B本体・JPEG処理・Frontend実装・C2以降の機能は変更していない。

### Findingと修正

open失敗後の`_release()`でcache cleanupが期限切れになると、旧実装はworkspaceを保持したままdocumentだけを空にしていた。同じworkspaceの再openを許可するため、残存cleanup workerが遅れて同じcacheを削除し、新しい原本と公開documentが不整合になる経路があった。監査時のfake RAW／streamによる一時再現では、再openのHTTP 200後に原本が消失した。

`RawPreviewApi`はworkspaceの状態を`empty → active → releasing → empty`として保持する。native解放またはcache回収が失敗・timeout・cancelした場合は`cleanup_failed`へ移り、workspace IDとcache ownerを保持する。`releasing`／`cleanup_failed`からの新規document openは409の固定codeで拒否する。capability GETに`workspaceState`と`cleanupPending`を付加し、内部path・例外本文を返さず状態を確認できるようにした。route追加や既存request形式の変更はない。

`RawSourceCache`はI/Oごとの結果Futureとdaemon thread、単一のcleanup taskを保持する。timeoutは待機期限だけであり、workerを終了扱いにしない。cleanup再試行は未完了の同じtaskを待ち、workerを重複起動しない。先行するdirectory作成／書込みworkerの終了を確認してから、所有directory・parent・所有済みflagをcleanup targetとして確定し、その値を削除workerへ渡す。遅延workerは実行時の可変directoryを削除対象として再取得しない。cacheはclose開始時点で新規downloadを受け付けなくなる。

### 状態・所有責任と回復条件

| 状態・共有値 | 所有者・条件・不変条件 |
|---|---|
| workspace状態 | API owner。`active`だけが新規open可能。`releasing`／`cleanup_failed`では既存workspaceの回収再試行のみ許可する |
| native解放確認 | API owner。RAW session reset成功後に記録し、その後のcache-only回収再試行でEngineを再起動しない。native解放失敗時はcache cleanupを開始しない |
| I/O結果Future／thread | cache owner。待機のtimeout／cancel後も保持し、処理終了を示すFutureを確認するまで次の回収workerを開始しない |
| cleanup task／target | cache owner。未完了taskはshieldして再利用し、削除対象は確定した旧directoryに固定する。結果が失敗した場合の再試行も同じtargetを使う |
| 回収完了の確認 | worker終了だけではworkspaceを再open可能にしない。既存DELETEの再試行でcleanup成功を確認してから旧workspaceを解放し、新workspaceの作成を許可する |
| shutdown | API close owner。native closeとHTTP ownerの終了後に同じcache cleanup taskを確認する。期限切れならcache／workspace／worker参照を保持して失敗を返し、後のclose再試行で回収する |

新しい固定codeは`raw_workspace_releasing`／`raw_workspace_cleanup_failed`／`raw_cache_cleanup_pending`（HTTP 409）、`raw_cache_cleanup_failed`（HTTP 502）。低層I/Oは安全な固定codeへ変換し、任意の内部例外・path・資格情報はAPIや診断へ出さない。cleanupが永続的に完了しない場合は再openを拒否したままにする。旧workspace IDの再利用を自動的に再開する仕組みは追加していない。

### 回帰確認と限定再監査

追加回帰は9ケース。gate／async eventでworkerの停止と再開を制御し、待機期限の注入でtimeoutを発生させる。競合順序をsleepの経過に依存させない。

- open失敗→cleanup worker停止→timeout→同一workspaceからの再openを409で拒否→gate解除→cleanup終了後も未確認workspaceでは拒否→DELETE再試行成功→別workspaceでopen／Preview成功、という監査経路を検証した。旧cleanupを再度joinしても新しい原本を削除しない。
- 実I/O例外によるcleanup失敗、close待機cancel、timeout後の同じworker／task保持、先行directory作成workerの遅延、worker起動失敗時の完了処理、別cache ownerの原本保護を確認した。
- 解放中／失敗状態の表示、shutdown中のcleanup timeoutと再試行、native解放失敗時に原本を保持して再openを拒否すること、正常open／close／再open、旧workspace／generation拒否、JPEG health継続も確認した。

Backend関連6ファイルは212件成功。その後、native解放失敗時の回収開始禁止を追加した最終RAW APIテスト22件も成功した（重複実行を含む）。Pythonはrepo `.venv`の3.14、cwdは`backend`。Windows sandboxの既知の非同期実行制約を避け、同じrepo executableを権限付きで実行した。Frontend実装は未変更で、既存API client／document hookの互換性テスト19件が成功した。全suiteや不要なFrontend buildは実行していない。`git diff --check`成功。

変更差分と直接依存するnative reset／close・HTTP owner・cache workerの順序を限定再監査し、今回の修正範囲の残存FindingはHigh 0／Medium 0／Low 0。修正前の「cleanupが未完了なのに同一workspaceの再openが成功する」経路は、API状態guardと閉鎖済みcacheの二重の受付拒否で成立しなくなった。

Windows実画面確認へ進める状態と判断する。ただし今回もfake MCP／streamと一時directoryによる自動検証であり、実LightCraft・GPU・Immich・RAW原本・sidecar・既存PoC成果物は操作していない。Windows/Tauri/WebView2実画面、実OSの停止したdisk I/O、強制終了後の残骸回収、実GPU障害fallback等の既存未検証範囲を追加認定するものではない。

## Phase 1C-C2実装結果（2026-10-22）

### 基準とC1実機確認

開始HEADは`f21f3354c74c2193e504e17dd5b397245df3bfe3`、開始時clean。LightCraft v0.10.0／commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`を維持した。ユーザーによるC1 Windows/Tauri実機確認は完了し、RAW原本取得・LightCraft PNG生成・暗室画像表示とLightCraft識別表示を確認済みの接続として再利用した。以下はC2の実装事実であり、C3／C4を完了した意味ではない。

### 実装したcontrolとUI

| control | 値域 | step／初期値 | 表示・意味 |
|---|---|---|---|
| `light.exposure` | -5..5 | .01／0 | EV、2桁 |
| `light.contrast`／`highlights`／`shadows`／`whites`／`blacks` | -100..100 | 1／0 | 基本補正、整数 |
| `wb.temp` | 2000..50000 | 50／spec 6500 | Kelvin。実際の開始値はreadback |
| `wb.tint` | -150..150 | 1／0 | native Tint。JPEG相対値と同一視しない |
| `color.vibrance`／`color.saturation` | -100..100 | 1／0 | native readback、整数 |

`backend/raw_controls.py`は固定v0.10.0の`crates/develop/src/controls.rs`の上記specだけをallowlist化する。`RawAdjustmentControls.tsx`は既存右パネルと`AdjustmentSlider`のrange・数値入力・keyboard／wheel・確定方法を使用する。共通Sliderの個別bypass／resetとカテゴリ・全体の操作ボタンはRAWにも配置するが、C4まではdisabledとし、現像設定を変更しない。UI focus用AdjustmentIdは再利用するが、値のbindingはnative control IDに分離し、JPEG reducer／Recipe・clipboardへ渡さない。WB・基本・色の3カテゴリのみを表示し、RAW Color Gradingは追加しない。

WBは`photo.inspect.as_shot_wb`の有限な範囲内2値と、設定の明示`wb.scale=kelvin`を確認できた場合だけ有効とする。この肯定的な証拠がない素材、scale省略（v0.10.0のlegacy表現）やlegacy素材はWBのみ無効。matrix／camera名から独自推測せず、Kelvinと旧相対値を変換しない。既存`develop.set`が行うscale正規化とAsShot→Customを利用し、readbackのmode／scaleを表示する。現段階でAsShotへ戻すReset操作は追加しない。判定不能素材でWBが無効になる制限は明示する。

### APIと非同期所有

追加routeはWindows専用`POST /api/raw/documents/{handle}/settings`と`POST .../controls`。前者はworkspaceId／generation／documentTokenだけでexplicit readback・resyncを行い、後者はさらにexpectedRevision／valuesを要求する。所有とidentity一致、整数revision、許可control・有限値・範囲を検証し、不正値は400、競合は409で拒否する。C1のbody上限・認証・Origin／Host・no-store・所有task／直列lockを維持し、任意MCP・原本path・PhotoId・資格情報は公開しない。共通Docker appにrouteを追加しない。resyncはsnapshotの確定状態を変え得るためPOSTとし、既存GETはnative処理を始めない。

応答は確定revision、control値・spec、Process Version、WB能力・mode・scaleのみ。値はnative readbackを正本とし、設定送信値を成功値として返さない。readback失敗後のpublic revisionは進めず、明示settings resyncでengine状態を確認する。HTTP切断でも送信済み操作はC1 ownerが完了まで所有する。

| 状態 | 所有・更新・不変条件 |
|---|---|
| API document revision | native readback成功後だけ更新。旧expectedRevisionでmutationしない |
| `RawControls.confirmed` | documentごとの確定settings／revision。Previewはこのrevisionを使用 |
| `desired` | 最新入力の未確定値。UIでは更新中であることを明示し、readback完了後に確定値へ戻す |
| `pending` | 最新未送信patch。処理中の1件と別にcontrol単位で上書き集約 |
| `serial`／busy／error | 新入力ごとにserialを進める。mutation・Previewは1ownerで逐次実行。結果不明は停止 |
| `useRawDocument` editorRef | Asset identityと一致したcallbackだけ操作可能。dispose後に成功や旧画像をpublishしない |
| 表示URL | native metadata・revision・frame serial、最新desired serialを取得後／decode後／表示直前に確認して採用。候補・旧URLをrevoke |
| capability `available` | 共有subscriberが非同期取得、15秒poll。初期・失敗・404はfalse、起動を待たせない |
| 保存preset／実効preset | 保存は3値を維持。利用不可時の実効値のみNon-RAW。回復時に保存値を再適用 |

入力は150 ms debounceで集約し、Slider commitは最後のpendingを即flushする。送信中の新入力は最新patchだけを保持し、中間revisionのPreviewを省く。Preview処理中の新入力は旧結果の表示guardを直ちに失効させる。画像更新のdocumentKeyはrevisionでは変えずzoom／panを維持する。競合は1回explicit resyncして最新patchを再適用し、再競合やHTTP timeout等の結果不明は自動再送しない。明示「再同期して再試行」はまずreadbackし、確定revisionでpendingを送信／Previewを再要求する。復旧できなければ写真を開き直す。以前の確定画像が残る間も更新中・失敗のラベルを表示し、現在値での成功と誤認させない。

写真切替／離脱は未確定値を成功扱いしない。transmitted mutationは完了まで所有したうえでC1 workspaceを解放する。値・Session snapshotの退避はせず、RAW設定は写真切替・終了で失われる旨を表示する。既存JPEG autosave／History／Exportは別系統。2枚保持・256変更試行のPoC制限は変更せず、C3の容量・長時間編集・往復復元へ残す。Before／After、Reset、Undo／Redo、RAW HistoryはC4。永続Recipe・最終Export・Immich登録は未実装。

### プリセットと検証結果

`appSettings.ts`の固定ロックを廃止し、保存値はread／update時にraw／bothを含めて保持する。Settingsの3選択肢はそのまま、Windows LightCraft capabilityがtrueのときだけRAW／両方を有効化する。Gallery／Stack badgeの実効presetは同じcapabilityでNon-RAWへfallbackし、手動選択優先・RAW-only等の従来fallbackを維持する。Dockerの404はunavailableであり、RAW編集対応と表示しない。保存値を書き換えないためcapability回復時にraw／bothが戻る。

最終関連検証はBackend 4ファイル139件、Frontend 15ファイル384件成功。Backendはrepo Python 3.14／cwd backendで、fake MCPを使用したcontrol mapping・readback・WB mode／scale、revision／所有拒否、切断後もownedなmutation、readback失敗resync、C1 cleanup／Windows認証を確認した。Frontendはgateと制御timerでdesired集約、commit flush、逐次処理、revision衝突・結果不明、古いPreview／callback破棄、切替、WBのみ無効、RAW／JPEG経路分離、capability前ロック・失敗／404・回復・保存値保持、既存Slider／Viewer／保存・Stack選択回帰を確認した。TypeScript checkを含む`npm run build`成功、既存500 kB超chunk警告あり。全suite・実GPU・実Immich・Windows画面操作は実施していない。C2のSlider操作とreadback／Preview、JPEG往復のWindows実画面受入はユーザーが行う。

### C2 RAWスライダーパネル仕上げ

JPEGとの画面比較を受け、RAWカテゴリ見出しと個別SliderにJPEGと同じdisabled ON/OFF・Reset配置を追加し、全体Resetも無効ボタンとして表示する。ツールチップ・aria-labelはRAWでは準備中と示し、すべての操作はdisabledでLightCraft設定を変更しない。色温度とTintのtrackはJPEG共有gradientを用いる。RAW値域・native mapping/readbackは変えない。基本補正の表示をJPEG同様に「Highlights→Whites→Shadows」とし、RAW IDはそれぞれhighlights／whites／shadowsのまま。

初期フォーカス不能の原因は、暗室から操作パネルへ入る`Shift+↑／↓`の入口がJPEG用`historyEnabled`を必須としていたこと。RAWは一時編集でJPEG Historyを所有しないため、フォーカス復帰が拒否されていた。RAW documentがreadyで操作を遮る画面状態がない場合に、同じ`restoreAdjustmentFocus()`を許可する。無効なWB rangeは既存focus registryが除外し、カテゴリ見出し・表示行を通じた移動はDOM順に従う。range上の矢印、wheel、数値入力と確定処理は共通Sliderを維持する。

回帰検証は関連Frontend 4ファイル201件成功。JPEGと同じ基本補正順、未フォーカス時のViewerからの初期focus、無効WBの除外、ボタン全27件disabled・クリック非作用、Temperature/Tint gradient、RAW値変更経路を確認した。`npm run build`（TypeScript checkを含む）成功。既存500 kB超chunk警告あり。JPEG側の共通Slider既定ボタン動作もfocused回帰で確認した。`git diff --check`成功。

## Phase 1C-C3-A実装結果（2026-10-22）

設計変更Commit `6aee67613750c2015c1b9532410d36257b564885`を基準にSQLite保存層のみを実装した。LightCraft v0.10.0／C2の操作・Preview・Frontendには変更を加えていない。DBに渡す設定がnative確定readback由来であることは内部callerの責務であり、document接続による保証はC3-B以降で実装する。

### 確定schema・検証規約

既存DBのschema v7はv6へ二つのRAW専用tableを追加する。v1〜v6のmigration chainとWAL／FULL接続を維持し、既存JPEG table・Queue・Export行は変更しない。

| Table | 列・制約 |
|---|---|
| `asset_raw_recipes` | `asset_id`、`source_content_hash`、`engine_name`、`engine_version`、`engine_commit`、`settings_schema_version`の複合PRIMARY KEY。`develop_settings_json`、`recipe_revision >= 1`、`last_save_id`（UNIQUE／receiptへの外部キー）、`updated_at`。settings schemaは正整数 |
| `raw_recipe_saves` | `save_id` PRIMARY KEY、`request_hash`（正規化identity＋expectedRevision＋全設定JSONのSHA-256、64桁hex）、`recipe_revision >= 1`、`updated_at`。過去の設定本文やHistoryは含まない |

Asset ID／saveIdはUUIDをcanonical文字列へ、content hash（16〜128桁hex）・engine名（64文字以内の安全なtoken）・commit（40桁hex）は小文字へ正規化する。engine versionは64文字以内、先頭数字の安全なtokenとしcaseを保持する。settings schema versionは1〜uint32上限、processは0〜uint32上限。engine/schemaの互換性判断と変換は保存層で行わない。

DevelopSettingsはUTF-8 JSON最大256 KiB、深さ32、走査node数32,768以内とする。schema `version`一致、`process`整数、WBのmode／数値temp・tint／optional scaleを検証し、非有限値・過大整数・非JSON型・重複JSON key・既知の内部resource fieldを拒否する。欠落scaleへKelvinを推定代入せず、全JSONを保持する。UI未対応fieldも切り落とさない。SQLiteにはhandle、PhotoId、cache path、source fingerprintを保存しない。ロード時も同じ検証とreceipt照合を行い、破損を黙って修復・上書きしない。

### 内部保存契約

`backend/raw_recipe_store.py`の`get_raw_recipe(identity)`は完全一致identityだけを読み、未保存なら`{recipe: null}`を返す。`put_raw_recipe(identity, expected_revision, save_id, settings)`は完全な確定readback設定を受け、`recipe`（identity＋settings）、`revision`、`lastSaveId`、UTCミリ秒`updatedAt`を返す。新規identityのexpectedRevisionは0、以後はSQLite側recipe revisionと一致する場合だけ+1する。LightCraft document revisionとは独立している。

保存は既存`edit_store._connection()`と`BEGIN IMMEDIATE`内でreceipt／current recipeをまとめて更新する。saveIdはRAW全identity間で一つのrequestへ固定する。完全同一requestは後続保存後でも元のackを返し、現在行は巻き戻さない。異payload・異expectedRevision・異identityへの再利用は`StoreConflict(save_id_reused)`、Revision不一致は`StoreConflict(revision_conflict)`。入力不正は`InvalidRawRecipe(invalid_raw_recipe)`、保存行破損／SQLite busy・full・I/O失敗は既存`StoreUnavailable(persistence_unavailable)`。receiptは設定Historyではなく冪等性を維持する小さな受付記録であり、C3-Aでは自動削除しない。JPEG保存関数・Queue変更は呼ばない。

### 検証結果と残件

Pythonはrepo `.venv`の3.14、cwdはbackend。RAW保存層86件と既存関連Backend235件（56 subtests）成功。v1〜v6→v7とDDL失敗時の全rollback、JPEG Recipe／History・Queue／Export行保持、複数identity、readback JSON全体保存、競合・同時保存・saveId replay／不正再利用、UTF-8上限・型・深さ、読込時破損拒否、実SQLite writer lock／SQLITE_FULL、書込／commit失敗時のrowとreceipt rollbackを確認した。通常sandboxのpytest TEMP作成失敗後は同じPythonの権限付き実行を用いた。テスト用の長大parameter IDで一時path生成が失敗した2件は短いIDへ修正して成功した。

schemaを検査する`release/smoke-test.sh`をv7／RAW table対応に更新し、その実際のSQLite assertion blockを新規v7テストDBへ実行した。フルDocker Smoke Test、Frontendテスト／build、実Immich・GPU・LightCraft試験は実施していない。migrationはテスト用DBだけに実行し、利用中のDBには触れていない。v6以前のBackendへ戻す場合は整合したmigration前DB backupの復元が必要で、downgradeは提供しない。

C3-B以降には保存済み設定のLightCraft適用・content hash／engine互換性確認・readback照合、RAW document API接続、Frontend autosave、写真切替・終了保存guard、Session再生成・容量管理を残す。C2は引き続き一時編集であり、C3-A完了を暗室の保存・復元対応とは表示しない。History／Undo／Redo・Before／Reset／ON/OFFはC4、RAW Exportは後続工程のまま。

## Phase 1C-C3-B実装結果（2026-10-22）

C3-A完了Commit `ecf3af1efdd34e867fc6e38b78a88389809a690a`を基準に、保存済みRAWレシピのLightCraft復元だけを接続した。C1／C2／C3-Aの上記記録は当時の完了範囲として保持する。LightCraft v0.10.0、schema v7、SQLite保存規約とJPEG経路は変更していない。

### import・照合・復元

既存Windows `POST /api/raw/documents`でdownload／import→`recipe_identity(handle)`→threadpool上の`lookup_raw_recipe(identity)`→`restore_persisted_settings()`→readback検証→document公開の順に進む。Asset IDはimport元のUUID、content hashは今回のLightCraft `photo.inspect`の値、engine versionはhandshake値、commitは既存adapterの固定`a2a41383c4fd62fa85a46ccd00998639221f2d3c`、schema versionは今回のreadback値である。実行binaryのcommitをhandshakeが証明しないという既存の制約は変わらない。

lookupはC3-Aのidentity正規化・完全JSON／256 KiB上限・receipt検証を再利用し、同一read transactionで一致を判定する。完全一致行を優先し、なければ同一Asset＋同一hashの行をengine非互換、同一Assetの別hash行を原本不一致とする。当該Assetの行がない場合だけ未保存として初期状態を返す。別行を推測適用・上書き・削除しない。

専用restoreはC3-Aの`validate_raw_recipe()`で再検証し、現在のactive handle／Asset ID／hash／engine=`lightcraft`／version=`0.10.0`／固定commit／schema=1を確認する。ローカルfile fingerprintは比較せず、既存`restore_settings()`の制約はそのまま残す。既存native reset→全settings merge→readback経路を使い、C2未対応のCurve／Geometry等も含めcanonical全設定が一致した場合だけ確定snapshot・native revisionを進める。省略WB scaleは既存のlegacy正規化に従い、Kelvinへ変換せず、DB行も書き換えない。

### 所有権・公開状態・失敗

DBはevent loop外で読む。Windows profile選択前に`edit_store`がDB pathをbindしないよう、RAW連携のpersistence importは実行時まで遅延する。lookup後・native処理後のworkspace/cache所有、closing状態、selection epoch、active handle／document token／generationを再確認し、復元中に切替・世代更新・終了が入った旧結果を公開しない。HTTP waiter cancelはnative操作のcancelにせず、既存ownerが処理を完了／回収する。C1のnative解放→cache cleanup順序とcleanup worker／再open拒否を維持する。

document応答に`recipeStatus=none|restored`、`recipeRevision=0|保存行revision`を追加した。既存`revision`は復元後のnative revisionで、C2設定取得・Slider変更・Previewはそれを引き続き使う。追加2項目はopen時の復元元を示し、その後のC2編集の保存完了を意味しない。全settings本文、原本hash、PhotoId、pathは新しい公開metadataに含めない。新しい保存endpointやFrontend操作は追加していない。

| 条件 | HTTP／固定code |
|---|---|
| 当該Assetに保存行なし | 200／recipeStatus=`none`。従来の初期状態 |
| 全設定readback一致 | 200／recipeStatus=`restored`。復元後revisionだけをPreviewへ渡す |
| 原本不一致 | 409／`raw_recipe_source_mismatch` |
| engine名・version・commit・settings schema非互換 | 409／`raw_recipe_engine_incompatible` |
| DB読込／保存データ検証失敗 | 503／`raw_recipe_unavailable` |
| native適用失敗／readback不一致／通信結果不明 | 502／`raw_recipe_restore_failed`、`raw_recipe_restore_mismatch`、`raw_recipe_restore_unknown` |

失敗時はdocument未公開・Preview未生成のまま既存releaseへ進み、DB行とreceiptを保持する。失敗を未保存や正常初期復元とは扱わない。内部APIへの不正recipeは`raw_recipe_invalid`でnative command送信前に拒否する。診断は復元成功と最終失敗の境界だけに安全なAsset ID・generation・revision・固定codeを出し、path・設定本文・内部例外を出さない。

### 検証と工程境界

repo `.venv` Python 3.14／cwd backendで関連7ファイル275件＋41 subtests成功。Fake LightCraft＋一時SQLiteを用い、未保存、別Asset無視、全設定適用、同hash／異fingerprint復元、hash大小文字正規化、原本／engine名・version・commit・schema不一致、C3-A JSON検証再利用、WB legacy省略、適用失敗・readback不一致・通信結果不明、HTTP cancel、復元中切替、lookup中世代更新、lookup／復元中shutdown、保存行不変を確認した。既存Phase 1B RAW動作、C1 cleanup失敗worker／再open制限、C2 controls／Preview、JPEG保存・Export Queueも回帰成功。Windows起動前importでDBが早期bindされないことを別Python processのテストで確認した。

`git diff --check`成功。Frontend変更・テスト・build、実LightCraft・GPU・Immich・Windows画面試験は実施していない。C3-C／DのFrontend RAW Autosave、写真切替・終了保存guard、Gallery復帰状態、多数resident・世代再生成・mutation容量対策には着手していない。RAW History／Undo／Redo／Reset・Exportも未実装。C2で新たに変更した値は、引き続き永続保存されない。


## Phase 1C-C3-C実装結果（2026-10-22）

C3-B完了Commit `5bdffb955103c2dcdfb36b9f20ca33c785c30915`から実装。C3-A／BとC1／C2の記録は上記時点の履歴として保持する。LightCraft v0.10.0、schema v7、完全DevelopSettings保存規約、既存の原本identity／engine互換性確認・復元経路は変更していない。

### 保存契約と共有状態

Windows RAW APIへrecipe GET／PUTを追加。PUTはworkspaceId／opaque handle／generation／documentTokenを検証し、`documentRevision`・`expectedRecipeRevision`・UUID `saveId`だけを受理する。LightCraftから現在の完全readbackを取得し、native revision一致を確認して`put_raw_recipe()`へ渡す。Frontendのdesired値やDevelopSettings本文は受け付けない。GETは同じ所有情報のheaderを検証し、SQLite保存metadataのみを返す。任意MCP、原本path／content hash／PhotoId、認証情報は返さない。既存LocalHostの認証・Host／Origin、JSON 4 KiB上限、no-store、同時要求上限を再利用し、Dockerへendpointを追加しない。

| 状態 | 所有者・更新条件・不変条件 |
|---|---|
| native `revision`／confirmed | LightCraft document／RawControls。readback成功でのみ更新。SQLite revisionと比較しない |
| `settingsFingerprint` | Backendが完全readbackのcanonical JSONをSHA-256化。Sliderにないfieldも比較対象。Frontendは本文を保持しない |
| `recipeRevision`／`recipeFingerprint` | SQLite保存ack／再同期metadata。未保存documentのopening baselineは初期readback、SQLite revisionは0。保存済みfingerprintとconfirmedとの差がdirty |
| desired／pending／serial | 既存RawControlsが保持。未確定値を保存済みにしない。切替前flushで送信完了・readbackを待つ |
| saveId／immutable retry request | 現在documentのRawRecipeSaveが1件だけ保持。応答不明は同じnative revision・expectedRecipeRevision・saveIdの再送を優先。新しい設定でIDを使い回さない |
| Backend `_recipe_save` | 同一active documentの直近request＋取得済み完全readbackを1件だけ保持。再送中に新しいnative編集があっても元payloadで冪等照合。次saveId／releaseで置換・解放。非active写真のsnapshot storeではない |
| locked／save error | useRawDocumentが切替・終了準備で新規操作を停止。clean ackまで維持し、失敗時は再試行またはstayで解除。離脱後の応答は後続ownerへ反映しない |

DB処理はthreadpoolで既存transaction／receiptを使用する。保存要求のHTTP waiter切断は送信済み処理をcancelしない。shutdownはowned taskのDB完了を待ち、native参照を解放してからcacheを回収する。commit後にclosing／owner喪失を検出した場合は502 `raw_recipe_save_unknown`として成功扱いしない。C1 cleanup worker／再open制限は維持する。

保存競合は409 `raw_recipe_revision_conflict`、異payloadへのsaveId再利用は409 `raw_recipe_save_id_reused`、不正入力は400、DB書込失敗は503 `raw_recipe_save_failed`、読込失敗は503 `raw_recipe_unavailable`。通信断／timeout／不正ack／5xxは結果不明として元requestを保持し、明示再試行で先にreplayする。元requestの再送がbusy等で拒否されても、初回が未commitだったとは判断しない。recipe競合時はmetadataを再取得してlocal confirmedを保持し、自動上書きしない。ユーザーの再試行で改めて再同期し、新しいrecipe revisionに対して未保存local設定を保存する。

### Autosave・写真切替・通常終了

`RawRecipeSave`はJPEGのuseAssetEditsを改造せず、5秒Autosave、dirty比較、revision／saveId、明示再試行という既存規約をRAW専用ownerへ適用した。saveId生成helperは共用するが、JPEG Recipe v18／History／EditStateSnapshotはRAWに渡さない。native操作・Previewと同じ所有queueで保存を逐次処理し、readback確定後だけ保存。保存中の追加入力は最新confirmedを後続保存し、古い保存ackで新しい編集をcleanにしない。

`prepareSave()`は入力停止→Autosave pause→最後のdesired flush→queue barrierでreadback完了確認→SQLite保存ack→dirty／unsettledなし確認の順に進む。RAW→RAW／JPEG、Galleryへ戻る操作、active RAWのFilmstrip除外、通常Windows終了へ接続した。保存失敗時は現在写真と編集を保持し、切替／終了を拒否して再試行・stayを提供する。Windows hostへは保存失敗を通知し、再試行後に再度通常終了できる。JPEG→RAWと残存JPEG保存は既存保証を維持し、RAWはJPEGの現像済み判定・History・Queueへ混入しない。

RAW→JPEG→RAW、Gallery再入場・新Backend/session後の再openはC3-BのSQLite復元を使用する。新しいmemory snapshot storeはない。UIは未保存／保存中／保存失敗と再試行を表示し、旧「写真切替・終了で失われる」をAutosaveと通常終了待機の説明へ変更した。C2配色・表示順・shortcut・disabled C4ボタンは維持する。

ブラウザー強制離脱・OS異常終了では最後の未保存操作まで保証できない。dirty／unsettledのbeforeunload警告を追加したが、非同期保存保証は上記アプリ操作境界とWindows通常終了に限定する。browser Back／reloadの新規非同期route guardは追加していない。

### 検証と残る境界

Fake LightCraft・一時SQLiteとHTTPでreadback保存、冪等再送／異payload拒否、競合再同期、readback revision不一致、書込失敗、HTTP切断、shutdown中commit／旧owner失効、再open・新BackendでのDB復元、認証・Host／Originを検証。Frontendは制御timer／gateで5秒Autosave、保存中の追加編集、結果不明の同一saveId再送と後続保存、競合時の非自動上書き、旧document応答拒否、最終desired flush、RAW→JPEG／RAW／Galleryと通常Windows終了の保存待機・失敗阻止・再試行、再入場復元を確認する。実行結果はdevelopment notesに記録する。

C3-C完了時点ではC3-Dのmutation上限前再生成等は未実装。後日の限定見直し（§8）で、複数resident最適化・cache性能改善は必須対象から除外し、同一RAWの上限前保存・再openだけを残した。既存2枚／generation 256試行のhard limit、写真切替の再download／再importを維持する。多数RAW・長時間編集を本工程の受入完了とはしない。C4のBefore／After・Reset・ON/OFF・History・Undo／Redo、RAW Exportにも着手しない。実GPU・Immich・Windows画面操作、全体suiteは実施しない。


## C3-D限定設計見直し記録（2026-10-22）

C3-C後の現行コードを確認し、§8・API候補・C3工程／未決定表を更新した。C3-A〜Cの保存層・復元・Autosave／切替guard、既存Session再生成とcache回収を再実装しない。C3-CのWindows実機RAWレシピ保存・復元成功はユーザー確認として記録した。C1／C2／C3-A〜Cの完了履歴を保持し、C4 History／UndoとRAW Exportの範囲は変更していない。

確認済み事実はコード参照を伴う§8.1／8.2、推奨未実装案は§8.2、通常切替と失敗時の限定判断は§8.3、最小受入条件は§8.4に分けた。256と実リソース量の因果関係や再生成性能は未測定であり、安全な大幅上限緩和の根拠はない。上限を保った同一RAWの保存済みレシピからの再openを推奨し、新しいresident manager・snapshot store・cache制御は追加しない。

今回は設計書のみ変更し、ソースコード・テスト・DB schemaは未変更。テスト／build／DB migration・実LightCraft／GPU／Immich／Windows画面操作は実施していない。文書差分と整合性を確認し、`git diff --check`成功。


## Phase 1C-C3-D実装結果（2026-10-22）

設計修正Commit `33a130eda91c868c8facc39ad80418b929b60d11`から、同一RAWの長時間編集に必要な部分だけを接続した。§8の旧候補を実装結果へ更新し、以前のC3-A〜C／設計見直し記録は各時点の履歴として保持する。LightCraft v0.10.0、native hard limit 256、SQLite schema v7、C1 cleanup・C2 Preview整合性・C3-C保存規約は維持する。

### 追加状態と責務

| 状態 | 所有・更新・不変条件 |
|---|---|
| mutationAttempts／mutationLimit／regenerationThreshold | Backendの既存実試行数からdocument／settings responseへ追加。200 soft、256 hard。Frontendは整数・固定値・範囲を検証。revisionから推定しない |
| interacting／RawControls.hold | Slider共通begin／commitをRAW hookへ接続。200以降の操作中は最新desiredを保持してnative送信を止め、操作終了後に最終flush。JPEG部品の操作ロジックは変更しない |
| restarting／locked／regenerationError | hookが自動再生成中と失敗を所有。再生成中の新規入力を拒否。失敗時も操作を止めてsession再試行を提供。通常切替・終了のprepareSaveは進行中の再生成完了を待つ |
| stage／expectedFingerprint／expectedRecipeRevision／oldGeneration | 現在documentの再生成工程・SQLite checkpoint metadataだけを保持。save完了前はrelease不可。release失敗時は旧workspace IDを残す。新設定本文や非active写真snapshot storeは作らない |
| editor／saverの置換 | save ack→旧owner dispose→既存queueでrelease→create/open→readback一致→Preview確認→新owner公開。旧世代callback・Preview・保存結果は新ownerへ反映しない |

200試行到達が操作中なら再生成せず、native patchをholdして最終desiredを集約する。pointer終了、数値確定、既存keyboard／wheel commit後に入力をfreezeし、最終flush・readback・SQLite保存ackを待つ。設定を初期値へ戻してDB未保存のbaselineになった場合も、再生成前は確定設定を明示保存する。保存中の結果不明は既存の同一saveId replayを優先し、native mutationを無条件再送しない。

workspace解放の`reset_session(restore_active=False)`、native参照確認後のcache cleanup、C3-Bの再import／原本hash・engine/schema確認／全設定復元を再利用した。Frontendも新generationと保存済みrecipe revision、readback／保存fingerprintの完全一致を再確認する。初期値や古いPreviewで復旧成功とは表示しない。再生成進行中・失敗・再試行をパネルに表示し、構造化診断へ安全な開始／完了／固定失敗codeを追加した。

保存失敗時は旧document／desired／保存requestを保持し、未解放のまま再試行する。release／cleanup失敗では旧workspace IDを保持し、新workspace作成を止める。open／復元／readback／Preview失敗ではDB保存rowを維持し、編集を再開せず明示再試行する。DELETE応答のみ消失したケースは再DELETEのconflictに加えてcapabilitiesのempty／cleanupPending=falseを確認した場合だけ回復する。workspace作成応答を失ってopaque IDを取得できなかった場合は所有を推定せず、既存lease等の回収を待つ安全側の拒否が残る。

通常RAW→RAW／JPEG／A→B→C→Aは既存queue／Backend lockを維持し、並列Session管理を追加していない。3枚resident最適化、memory snapshot store、LRU、cache再実装、汎用reset API、C4各機能、RAW Exportは未実装・対象外のまま。

### 検証と実機残件

Fake LightCraft／一時SQLiteで複数generation合計256試行超の編集、最終flush・保存fingerprint一致、復元による新世代1試行からの継続、旧handle拒否、native 256 hard拒否の維持、3 RAW巡回・各row保持を確認。Frontendは制御timer／gateで200到達中の300入力集約と201試行での最終保存、保存失敗replay、cleanup失敗で新規createなし、restore mismatch拒否、再試行、再生成中の入力／切替待機、旧Preview／callback拒否、解放応答消失後のempty確認、高速切替直列化を検証した。JPEG保存・History・Queue・Viewer・Windows終了の関連回帰も対象とした。最終件数と型チェック・build結果はdevelopment notesへ記録する。

実GPU・実Immich・Windows画面・長時間負荷・RSS／GPUメモリ回収・再生成待ち時間は未検証で、ユーザー実機受入へ残す。200は操作継続と試行予算のための保守的な確定値であり、実memoryの安全限界を実測した数値ではない。実機で問題が出た場合も、native上限撤廃や複数residentの先行実装で代替しない。

## Phase 1C-C4-A 詳細設計（2026-10-22〜23、Asia/Tokyo）

### 1. 調査基準・適用順序

- 開始ブランチは `feature/lightcraft-integration`、HEADは `e2e357824995d54f9f1d269432f11a2cfac81ac2`、作業ツリーはclean。Fetch／Pull／Resetは行っていない。
- GenzoRoomは現在のローカルコードを正本とし、C3-A〜D完了記録および `docs/architecture.md` のRAW・JPEG編集・保存・Viewer・Export・サムネイル境界を照合した。
- LightCraftは既存参照worktreeのHEADが固定 `a2a41383c4fd62fa85a46ccd00998639221f2d3c`（v0.10.0）であることを確認した。全面再調査はせず、既存 [C4 native features調査](PHASE1C_C4_NATIVE_FEATURES.md) §2〜6を根拠に、WB Reset・section対応・headless renderの必要箇所だけを追加確認した。
- 本節内の「C4-A最終補正」がC4最新の確定設計。上記初期設計とnative調査書§7〜10の旧C4提案、`docs/architecture.md`の現行JPEG配置等の記述は各調査・実装時点の記録として保持し、C4以後のReset／カテゴリ／Recipe変更には本節を優先する。
- **今回の変更は本書のみ。以下のtable／API名は実装提案であり未実装。ソース・テスト・LightCraft・実DBは変更せず、migration・テスト・build・ブラウザ／実機検証は行わない。**

### 2. 現行コードで確認した事実

#### 2.1 保存・復元・revision

| 追跡点 | 現行の責務とC4への接続点 |
|---|---|
| `backend/raw_recipe_store.py::normalize_identity/_settings_json/_read_row/lookup_raw_recipe/put_raw_recipe` | Asset UUID＋原本content hash＋engine名／version／commit＋settings schemaの6項目identity。完全DevelopSettingsを256 KiB以内で検証・保存する。現在レシピとsave receiptのみでHistoryはない。lookupは原本不一致／engine非互換を区別し、推測復元しない |
| `backend/edit_store.py::_create_v7/_connection` | 現在schema v7。`asset_raw_recipes` と `raw_recipe_saves` を所有し、WAL／FULL／busy timeout／`BEGIN IMMEDIATE`を使用。JPEGは `asset_edit_states` のcurrentRecipe・history JSON・cursorを同時保存するが、そのRecipe v18検証やQueue副作用をRAWへ転用できない |
| `backend/storage.py::validate_existing_database` | v7上限と必須列を検査する。RAW Historyのadditive schema追加時はmigrationだけでなく起動時検査・`release/smoke-test.sh`のschema期待値も更新が必要 |
| `backend/windows_raw_api.py::_restore_document/_recipe/_execute` | open時にSQLite lookup→互換性確認→native適用・readback一致→document公開。recipe PUTは所有情報・documentRevision・expectedRecipeRevision・saveIdだけを受け、Backendが完全readbackを保存する。FrontendからSettings本文は受けない |
| `backend/lightcraft_raw.py::_mutate/_restore/restore_persisted_settings/get_settings` | active写真を選択し、native command→`develop.get`→確定snapshotを更新。復元はreset→全settings merge→canonical readback一致。失敗・結果不明ではdesynchronized扱い。復元用6項目identity検証を通常のprivate snapshot fingerprint条件から分離済み |
| `frontend/src/rawControls.ts::RawControls` | 150 ms debounce、最新desired／pending、既存queue、1回のrevision conflict resync、readbackとPreviewのserial確認を所有。`settle()`は送信・readbackのqueue barrier。中間patchとgesture確定は別で、まだ履歴は作らない |
| `frontend/src/rawRecipeSave.ts::RawRecipeSave` | 確定fingerprintのdirty判定、5秒Autosave、SQLite revision、同一saveIdのimmutable retry、競合時のmetadata再同期。dirtyは今のところ設定差とretry requestのみで、履歴cursorの差は表現しない |
| `frontend/src/useRawDocument.ts::notify/prepareSave/restart/install` | 現在documentのControls／Save ownerと既存ownership queueを束ねる。離脱前freeze→desired flush→readback→save ack。200試行到達時は操作終了後に保存・release・再open・世代／revision／fingerprint確認。新たなresident／snapshot storeはない |

native `revision`は設定適用・再同期を識別する値、SQLite `recipe_revision`は保存transactionの順序、saveIdはimmutable requestの冪等性キーであり、互換なカウンタではない。`_mutate`はrevisionを先に予約するため失敗で欠番があり得る。`mutationAttempts`は失敗を含む実試行数で、200 soft／256 hardをrevisionやHistory件数から計算しない。既存restoreも1 adapter mutationとして数えるが、その内部ではreset＋mergeを実行する。

`raw_recipe_saves.request_hash`はidentity＋expectedRevision＋完全設定を束縛し、`_read_row`もこの形式でcurrent rowのreceiptを検証する。古いsaveIdの同一request再送も元のackを返し、後続保存を巻き戻さない。**cursor／操作種別を付けずにこのhashだけを流用すると、同じ設定へ戻る異なる履歴操作を識別できない。** C4には追加の履歴操作receiptが必要である。

#### 2.2 gesture・画面・JPEG

- `AdjustmentSlider.tsx`のpointer up／cancel／lost capture、数値Enter／blur、keyboard／wheelの500 ms無操作、unmountに既存commit境界がある。数値Escapeは開始値を再送してcommitするので、差がなければ履歴を作らない。keyboard／wheelはbeginを複数回呼び、rangeの一部changeではbeginなしでもcommitへ進む。単純なbegin回数やdebounce完了回数を履歴数にしてはいけない。
- `RawAdjustmentControls.tsx`は現在WB→基本→カラーの3カテゴリ。RAW個別・カテゴリReset／powerはdisabled placeholder。公開 `controls_state()` は数値・WB能力・processだけで、`disabled_sections`は公開していない。C4では必要sectionのenabled状態を安全なbool subsetとして追加できる。
- JPEGの `editing.ts::commit/editSession` はpending開始値と最終値を比較し、no-opならRedo枝を残し、変化があるときだけcursor以降を破棄する。Undoはpending確定後に1つ戻り、Redo／History jumpもpending確定を先行する。`EditHistory.tsx`は新しい順に表示し、操作後状態とInitial State（cursor 0）へ移動する。ただし表示はJPEG `EditEntry` と相対値formatに依存し、その型へRAWを入れられない。
- `useAssetEdits.ts` はJPEG session・Autosave・exit compactionを所有する。Undo shortcutは同じhandler内でFilmstrip除外Undoを先に判定し、JPEG編集へ進む。RAWの別listener追加だけでは二重実行を防げない。`AnshitsuPage.tsx`の `historyEnabled`／左panel、Reset、menu、shortcut dispatchもRAW用availability分岐が必要。
- `ImageViewer.tsx`はすでに `documentKey` でframe URLと写真identityを分離し、同一documentのRAW Preview更新でzoom／panを保つ。旧設計§5の「src変更で常にFitへ戻る」は現行には当てはまらない。ただしRAW Before入力は未接続で、`AnshitsuPage`は `beforeAvailable={!activeDetail.is_raw}`。JPEGは `AdjustedImage` の2 Canvas切替であり、plain RAW imgへBefore状態だけ渡しても画像は切り替わらない。
- JPEG個別OFFはUIだけでなく `editing.ts::effectiveAdjustments` と `backend/jpeg_renderer.py::JpegRenderer.render` に作用する。CPU／Workerは前者を使い、`webgpuRecipe.ts::prepareGpuRecipe`も前者を使う。Backend rendererはExportと補正済みサムネイルの共通境界なので、UIだけ消すと操作不能なOFFが残る。
- 個別power参照は `AdjustmentSlider`、`WhiteBalanceAdjustmentControls`、`BasicAdjustmentControls`、`ColorAdjustmentControls`、`ColorGradingAdjustmentControls`、`AnshitsuPage`のslider context menu、`AdjustmentContextMenu`、`adjustmentNavigation.ts` にある。カテゴリ・Color Grading range menuも共通context menuを使うため、共通toggle行の無条件削除は不可。`editClipboard.ts`は数値だけをコピーし、enabled状態はコピーしない。

### 3. 今回確定済みの製品仕様

1. **RAW History：** GenzoRoom SQLiteが唯一の正本。完全DevelopSettings snapshot、操作単位、Undo／Redo／履歴選択／新操作でのRedo枝切りはJPEGの操作体系に合わせる。native History／Session Undoは呼び出さず、targetの完全設定適用とreadback確認で復元する。C3-C guard・C3-D再生成を維持する。
2. **カテゴリ配置・ON/OFF：** RAW・JPEGとも**カラー**を最上部、**基本補正**をその下に配置する。カラーは色温度・Tint・自然な彩度・彩度の4項目を含む1カテゴリで、カテゴリON/OFFとResetも共通化する。JPEGのColor Gradingは独立カテゴリで維持する。RAWのカラー4項目はLightCraft native `color` bypassで値を保持して無効化する。
3. **RAW Reset：** 温度とTintの個別ResetはいずれもWBペア全体を正確なAs Shotへ戻す。カテゴリResetとAll ResetもWBをAs Shotへ戻す。As Shotのreadbackがsource由来のWBと一致しない、または正確に適用できない場合は成功として履歴へ追加せず、代替値を推測しない。各Resetは全体で1つのHistory操作としてUndo可能。All Resetはnative `develop.reset`を基礎にする。ResetでGenzoRoom Historyを消さない。編集開始baselineへ戻す別Reset、RAW個別ON/OFF、WBプリセット選択UIは追加しない。
4. **RAW Before：** native初期現像 `import_defaults()` を基準とし、現在crop／orientationの適用はnative標準に従う。手動レンズ歪曲補正をBeforeへ強制転写しない。初回Previewを固定保存する方式、After設定をBefore値へ一時変更して往復renderする方式は採用しない。
5. **比較表示：** 既存ImageViewerのBefore／After switch・一時表示・zoom／pan体系を使う。1024pxは現在の暫定Preview制約であり将来の固定仕様ではない。高解像度化自体はC4対象外。
6. **JPEG：** 個別ON/OFFの操作と現像上の効果を廃止する。RAWと同じカラー（温度・Tint・自然な彩度・彩度）／基本補正（露出・コントラスト・ハイライト・白レベル・シャドウ・黒レベル）へ統合し、カラーを最上部、基本補正をその下に置く。Color Gradingは独立カテゴリ。統合カラーのON/OFF・Resetは一操作で行う。Recipe v18、SQLite schema、`whiteBalanceEnabled`・`colorEnabled`の両fieldは維持するが、以後は同じカラーカテゴリ状態を表し、別々の操作を発生させない。16個別flagは今後すべて有効として扱う。個別Reset・基本補正／Color Grading ON/OFF・History・コピー／ペースト・Before／After・補正済みサムネイル・Exportを維持する。過去状態の互換・migration・救済は設計しない。
7. RAW Export／Immich登録、RAW補正済みサムネイル、Gallery RAW編集状態filter、高解像度Preview、crop／geometry UI、WBプリセットUI、mask／AI、LightCraft更新は対象外。「現」バッジはExport素材識別のままでRAW編集状態へ転用しない。

以下の推奨保存構造はRAW Historyに必要な**additive schema追加**であり、「JPEG側SQLite schemaを維持」と両立する。既存RAW current recipe tableとJPEG tableを置換・削除しない。今回schema操作は実施しない。

### 4. 推奨実装：RAW Historyの保存契約（C4-B）

#### 4.1 最小の永続構造と不変条件

既存 `raw_recipe_store.py` を拡張し、独立したmemory History managerは作らない。提案する追加tableは次の3つ。history用JSONをJPEG tableへ押し込まず、stepごとの最大256 KiB検証を既存validatorで共有する。保持上限200は実行時の履歴保持ポリシーであり、DB schemaやtable CHECK制約へ埋め込まない。後日のポリシー変更や手動整理・圧縮に拡張できるようbaseline・step列・cursorの構造を保つ。

| Table案 | 最小項目と責務 |
|---|---|
| `asset_raw_histories` | 既存6項目identityをPK／current recipeへの複合FK、`baseline_settings_json`、`history_cursor`。cursorは適用済み操作数0..N。baselineは保持範囲の開始状態でありBeforeの基準とは別。current recipe revisionを共通CASとして使い、独立したhistory revisionは作らない |
| `asset_raw_history_steps` | 同じidentity＋`position`（1..N）をPK、stable UUID `step_id`、固定 `kind`、許可control／section ID等のbounded metadata、完全 `develop_settings_json`（操作後）、`created_at`。beforeは前stepまたはbaselineから得てsnapshot重複を避ける。history parentへのFKを持つ |
| `raw_history_saves` | `save_id`をPK（対応する既存RAW receiptへのFK）、操作request hash、結果recipe revision／settings fingerprint／cursor／件数／stable target等のbounded ack metadata。snapshotは保存しない。branch削除・上限整理後も再送の元ackを返すため、step削除に連動して消さない |

- 同じAssetでもhash・engine tupleが違えば別History。handle／generation／PhotoId／local fingerprint／pathを永続キーにしない。既存identity不一致の復元拒否を維持する。
- transaction成功時に `asset_raw_recipes.settings == baseline`（cursor 0）、または `== steps[cursor].settings` をcanonical JSONで保証する。position連続、cursor範囲、UUID重複、snapshot schema・上限を読込時にも検証し、破損を空Historyで隠さない。
- 既存C3レシピにHistoryがなければ**その復元済み設定をbaseline**として遅延初期化する。過去操作やimport初期値への架空Undoを作らない。未保存RAWは初回readbackがbaseline。初回の有効commit／再生成用checkpointで同transaction内にparentを作る。openしただけで保存しない。
- 保存receiptは既存 `raw_recipe_saves` の形式を保持する。追加receiptのhashはidentity・expectedRecipeRevision・operation kind／operation ID・target step IDまたはbaseline指定・完全設定fingerprint等を束縛する。saveId再利用の検出は既存recipe-only requestとHistory requestの間も行う。snapshot本文を重複保持するreceiptにしない。
- `put_raw_recipe()`を外から呼んだ後に別transactionで履歴を書いてはいけない。既存の内部write処理をconnection受取helperへ最小抽出し、1つの `BEGIN IMMEDIATE` でCAS確認→枝切り／step追加またはcursor更新→current recipe更新→両receipt→上限整理→commitとする。JPEG save・Queue処理は呼ばない。
- 新commit／cursor変更は共通recipe revisionを+1。同一設定でも別cursorへの移動なら保存が必要。今の設定fingerprintだけのdirty判定へ「未確定gesture／未ack History操作」を追加する。同一saveId再送は新しいstepもrevisionも増やさない。replay ackは過去結果なので、最新cursorへ無条件適用せず現行metadataを再取得する。

#### 4.2 gesture確定、Autosaveと再生成

推奨は**操作確定時にHistoryとcurrent recipeを直ちに同時保存**する。5秒分の完全Settings列を別memory storeへ貯める方式を避け、gesture中のnative中間値は現行Controls内だけにとどめる。C3の5秒Autosave ownerは継続し、確定操作の未保存retry／checkpointを同じwriterへ流す。通常の操作は5秒より早く保存されるが、保存失敗・再試行・離脱保証は弱めない。

1. 最初のchange前に既存queue上でgesture開始を登録し、現在SQLite cursor／recipe revisionと開始readbackを固定する。同じ操作の繰り返しbeginは同じoperation IDで無害にし、beginなしchangeには暗黙beginを行う。別control開始は前操作を確定してから進める。Frontendは完全Settingsを持たない。
2. `RawControls`の150 ms patch／Previewはそのまま使う。中間readbackでstepを追加しない。gesture中は `RawRecipeSave.observe` の「settled」条件へgesture完了も含め、途中に5秒停止してもcurrent recipeだけを中間値へ保存しない。Backendでも未終了gesture中の通常checkpointを拒否／待機させる。
3. 既存commitで最後のdesiredをflush→queue barrier→完全readback→開始値との差を判定する。変化なしならstep追加・Redo枝切りなし。有効な変化だけ1 stepとcurrent recipeを同時commitする。Sliderの500 ms境界とnative patch debounceを混同しない。
4. commit保存中は次のgesture／Undo／Resetを止める。既存の `_recipe_save` を一般化した**現在操作1件のimmutable retry payload**だけを保持する。これは輸送復旧用であり、非active写真・履歴列のmemory storeではない。native確定済みでもDB失敗なら未保存表示と操作lockを保つ。
5. `prepareSave()`はgesture確定まで含むsettle→History/currentのack→既存clean確認。写真切替・Filmstrip除外・Gallery復帰・Windows通常終了はこの関数を引き続き使う。unmountのlate commitで次documentへ送らない。ブラウザ強制終了／OS障害の最後の未commit操作は保証外という既存境界を維持する。
6. C3-Dの200到達notifyはHistory確定を先に待つ。操作中hold→最終flush→History/current transactionのack→既存release／再open。新世代はrecipe revision／fingerprintだけでなくHistory cursor・末尾step ID／件数も照合し再取得する。native復元を新しい履歴操作として記録しない。再生成進行中のHistory／Resetは無効。

native begin/endInteractionはGenzoRoom Historyの成立条件にしない。現行 `_mutate` が毎回 `library.select` を行いnative interactionを終えるため、追加するだけでは効果がなく、C3-Dによるnative蓄積上限も既にある。必要になるまで接続しない。queue実行中に同じqueueへ処理を積んでawaitするdeadlockを避け、UI ownerが順序を組み、Backendは既存lock内でnative→DBを直列実行する。

#### 4.3 Undo／Redo／履歴選択と失敗境界

履歴一覧APIはboundedなkind／表示数値／step ID／cursor／件数とrevisionを返し、完全SettingsをFrontendへ送らない。undo／redo／jump要求も任意JSONではなくtarget ID（またはbaseline）とexpectedRecipeRevision・documentRevision・saveId・既存所有情報だけを受ける。Backendが同identityのSQLite targetを読み、完全設定を `restore_persisted_settings()` の検証付きreset／merge／readbackへ渡す。target read中に外部saveがあればcommit時CASで拒否する。

pending gestureを確定→target取得→native適用→全readback一致→cursor/current/receiptの同時保存→ack→controls／History表示／Preview更新の順。履歴操作自体は新stepを追加しない。Undoで残るRedo列は保持し、その後の**有効な新操作の保存transaction**でのみ削除する。History jumpは対象操作後の状態、Initial Stateは保持baselineで、JPEGと同じcursorの意味にする。

| 失敗境界 | 保持状態と回復 |
|---|---|
| native送信前の所有／revision／target不一致 | SQLiteもcursorも変更せず拒否。古いindexだけで別のstepを選び直さない |
| 通信断／timeout／readback mismatch | DB cursor・currentは旧状態。画面を成功扱いせず、desired・targetと操作IDを保持してlock。native結果不明を自動再送しない。明示retryでreadbackしtargetと一致する場合だけ保存へ進み、不一致なら検証付き復元を行う |
| native一致後のSQLite busy/full／commit失敗 | DBはtransaction rollback。nativeはtargetになっていても「未保存の履歴移動」として表示し、確定cursorは旧位置のまま。次操作・切替・終了・再生成を止め、同一payload/saveIdの保存retryを優先。自動rollback mutationは追加しない |
| SQLite commit後のHTTP応答消失／owner失効 | commit不明として保持。receiptを先に照合する同一request再送で解決。新しいnative revision不一致だけで既commitのreplayを拒否しない。再送後は最新metadataでcursorを同期 |
| CAS競合 | 自動上書き・自動branch mergeをしない。currentとHistory metadataを同じread transactionで再取得。local操作は保持するが、自動rebaseせず、明示再試行で期待revision／targetが有効か再確認。両立しなければ再openによる保存済み状態の復元が必要 |
| Preview／decode失敗 | DB commit成功と画像失敗を区別。cursorや保存を巻き戻さず、同じ確定revisionで画像だけ再試行。古いPreviewには未更新／失敗表示を付ける |

cursor確定までlockするため、各操作を直ちにSQLite保存する場合もC3の保存guardを一本化できる。Undo targetを適用する前に保存対象となった旧gestureを先にackし、古いsave ackで新cursorをcleanにしない。サーバーshutdown／HTTP切断時も既存owned taskの完了待機を維持する。

#### 4.4 保持件数と読込容量

保持上限は**200操作＋baseline 1 snapshot／identity**（nativeの上限とは別のGenzoRoom契約）。有効な新stepを追加する前にRedo枝を破棄してから上限を判定する。超過時は同じ保存transaction内で最古の適用済みstepから必要数を削除し、削除した最後のstepのafter snapshotを新baselineにする。cursorから削除数を差し引いてpositionを詰める。Redo枝破棄・prefix整理・新step追加の前後で、現在recipeとcursorが指す状態が一致することを検証する。200は実行時ポリシー定数で、schemaには固定しない。履歴管理tableはbaseline・step列・cursorを保持し、後日手動History整理／圧縮を加えられる形にする。JPEG側の手動clear／trim／compact UIやAPIはC4に追加しない。

256 KiB × 201で設定本文の最悪約50.25 MiB／identityとなる。これは上限計算であり、実測値ではない。履歴一覧へ本文を返さず、targetだけを読み、検証もboundedにする。receiptは既存同様自動削除しない。全Asset合計容量の自動削除やLRUはC4に追加しない。

### 5. 推奨実装：カテゴリ・Reset（C4-C）

専用adapter methodは既存 `_mutate` を通し、許可control／sectionだけをWindows RAW APIへ公開する。Frontendへ `command_run` や任意section文字列は公開しない。各論理操作の最終readbackを§4の同じHistory writerへ渡し、native操作成功だけで完了としない。

| 操作 | native接続と範囲 |
|---|---|
| 基本ON/OFF | `develop.sectionEnabled {section:"light", enabled}`。lightとcurveへ作用するnativeのまとまりを維持。UI未対応curveを独自に分離しない |
| 最上部カラーON/OFF | `develop.sectionEnabled {section:"color", enabled}`。統合したWB／自然な彩度／彩度は同じbool。nativeではmixer／grading等も含む（native調査§3）。値は保持し、OFF中のResetも可能にする |
| Basic／彩度個別Reset | `develop.resetControl {control}`。WB以外のallowlist controlだけ。`ControlSpec.default`へのResetであり、編集開始値へ戻す操作ではない。色温度・Tintの各Resetは次行のAs Shot WB全体Resetへ接続する |
| 基本カテゴリReset | `develop.resetSection {section:"light"}`。native Light ResetはCurve Resetを含まない。bypassとResetの範囲差を説明し、UI未対応Curveを推測resetしない |
| 温度／Tint個別Reset | `develop.resetControl`をWB fieldへ使用しない。いずれのResetボタンも `develop.wb {mode:"asShot"}`でWB全体を戻し、source由来のtemp／tint・mode・scaleをreadbackする。UI label／tooltipで両値が戻ると伝える |
| カラーカテゴリReset | `develop.resetSection {section:"color"}`でnative Color controlsをreset後、`develop.wb {mode:"asShot"}`。WBを含む完全Settingsを検証して1つのHistory操作にする。disabled_sectionsは維持する |
| All Reset | `develop.reset`で全体をresetし、`develop.wb {mode:"asShot"}`を実行して完全readbackする。import_look等で標準reset後のWBがAs Shotでなければ、As Shot適用後の全Settingsを確定値にする。Reset全体を1つのHistory操作に保存し、History自体は消去しない |

**WBで追加確認した事実：** 固定ソース `crates/develop/src/controls.rs`の `wb.temp`既定値は6500、`wb.tint`は0。`controls::set()`はfield代入なので個別ResetはAs Shot mode／撮影時値を保証しない。`DevelopSettings::reset_section(Section::Color)`はWBを既定数値へ戻してmodeだけAs Shotにする。`crates/engine/src/cmd/develop.rs`の `develop.wb` はsource infoのAs Shot値を解決・scale正規化後に保存し、temp／tintを許可範囲へclampする。renderはmode名だけでは撮影時WBを再計算しない。このためmode=As Shotというreadbackだけでは合格にせず、source由来の実値・scaleまで一致を要求する。

All Resetの `import_look`分岐もWBを必ずAs Shotへ変更するものではない（native調査§5）。標準Reset後に明示的にAs Shotを設定し、source由来のWBとreadbackが一致した場合だけReset全体をHistoryへcommitする。As Shotを正確に表現できない、またはreadbackが一致しない場合は成功扱いせず、推測値へfallbackしない。複合Reset途中で失敗した場合は開始時の完全Settingsへ戻してreadback検証する。復元も一致しなければdocumentをdesynchronizedとしてlockし、成功表示せず明示的な同期回復を要求する。

Reset／section toggleも `_mutate` のbudgetとdocument revisionを通す。複合Resetは「SQLite Historyは1件」でもnative command数を1と偽らない。推奨はbounded command列を1 adapter操作で実行し、**送信したdevelop mutation commandごとにattemptを保守的に計上**する（readback／select／Before設定選択はmutationでない）。既存restoreのreset＋mergeも同じ計上に揃えるなら、C3-D testの期待attempt数だけを合わせる必要がある。200／256定数、hold・保存・再生成の責務は変えず、複合操作開始前に必要な残予算を確認する。途中command失敗ではdesyncとし、半分成功した操作を別Historyへ分割しない。

### 6. 推奨実装：Before／After（C4-D）

#### 6.1 最小MCP拡張とadapter／HTTP

native調査§2／§6の通り、`render_preview`→`render_photo`→`ui.render`→`Headless::render`→`render_now`が `before=false`固定。`beforeAfter.setBefore`で基準だけ選択しても既存画像toolの出力はAfterのままである。

- LightCraft `crates/mcp/src/tools.rs`：`render_preview`のtool入力schema・説明と `render_photo` にoptional bool `before`（既定false）を追加し `ui.render`へ転送。既存After呼出しと返却PNG／metadataを維持する。
- `crates/mcp/src/headless.rs::Headless::render`：trueなら既存 `session.render_job(id,size,size,true,true)` を実行して通常renderと同じ結果処理へつなぐ。`render_now`のrun／accept／error処理との整合性を確認する。Engine全体の既定動作やGUIには変更しない。
- 未対応binaryが未知flagを無視してAfterを返す事態を防ぐため、MCPのtool schemaで対応有無を検査し、responseにも実際の `before`種別を追加してadapterが検証する。versionが同じ0.10.0というだけで拡張対応としない。既存handshakeのcommit非証明という制約も残る。
- GenzoRoom `lightcraft_raw.py`：既存Preview ticketへkind／Before keyを追加、Before renderを同じmanager直列化・PNG／寸法／PhotoId検証に通す。現在の単一pending ticketでBeforeとAfterを相互に誤supersedeしないよう、同一documentの表示要求をAfter優先で順序付けする。処理経路や画像上限を複製しない。
- `windows_raw_api.py`の既存preview POSTへ `kind:after|before`を追加する案。所有情報／confirmed revision／serial検証とno-storeを維持し、種別・Before cache keyもresponse headerへ返す。既存HTTP画像5 MiB／MCP Preview上限は維持。maxSide=1024は当面継続するがcache keyに寸法を含め、将来拡張可能にする。
- `rawApi.ts`のframe型／header検証、`useRawDocument.ts`の要求・decode・URL解放を拡張する。拡張非対応ならRAW After編集を継続しBeforeだけ無効化する。Before失敗をAfter／Immich画像のBefore表示で埋めない。

新importごとにadapterが `beforeAfter.setBefore {source:"import"}` を明示し、native初期現像を選ぶ。Before sourceの任意History／current選択UI・永続設定は作らない。通常の復元やUndoはAfterだけを変える。native復元中の `develop.reset` をBefore基準保存の代用にしない。

#### 6.2 キャッシュとViewer

Beforeは初回表示要求時に遅延生成する。ユーザーの「crop変更後の初回Originalは遅く、2回目以降は瞬時」「手動レンズ歪曲補正はBeforeへ出ない」というWindows観察は受入の参考とし、GUI内部cache実装の証明とは扱わない。

| 状態 | 所有・寿命・無効化 |
|---|---|
| Before基準 | LightCraft Session。各importでimport defaultsを選ぶ。DB current／履歴baselineから作らない。再生成／再入場で選び直す |
| Before render key | Backendがdocumentのimport基準識別子・source identity・engine tuple・確定readbackのcrop／orientation・出力寸法／crop有無から作る。nativeの有効Before設定fingerprintもrender metadataで照合する。Afterだけの露出／WB／歪曲変更は含めない。Frontendへ設定本文やsource hashは出さずopaque fingerprintで渡す |
| Before PNG／Blob URL | active document内の圧縮画像1件のみをFrontendが保持。再要求を同じkeyで集約。正しいdecode・寸法・kind・key確認後に差替え、旧URLをrevoke。永続disk cache／写真横断cacheは作らない |
| 無効化条件 | source／document／generation／token変更、Before基準変更、native有効Before設定変更、要求出力寸法変更。crop／orientationはnativeに従いkeyを更新。単なるAfter slider／カテゴリ／ResetでBefore keyが不変なら再利用可能 |
| 非同期所有 | 既存selection serial／document revision／epoch／sequenceにkind／keyを追加。生成開始後にcrop・寸法・documentが変わればstaleとして破棄し候補URLを回収。After revisionが変わってもBefore keyが同じ場合の再利用は、最新ownerとkeyの再検証後だけ許可 |
| RAW切替・Session再生成・離脱 | Before画像・候補・pendingを破棄し、再openのnative基準から再生成。JPEGのpersistent Before/After選択は現行どおりAnshitsuPageで所有し、表示要求がBeforeなら新RAWの有効画像を待つ。画像cache自体は持ち越さない |

cache lookup前のkeyはBackendが既に持つ完全確定snapshotのcrop／orientationから計算する。Before基準は同一document内でimportに固定するので、基準識別子はdocument生成時に固定でき、新しいSettings snapshot storeは要らない。native `before_settings()`のfingerprintを生成結果に付けてこの契約を検証する。追加toolを増やさず、keyはsettings応答にも返し、画像取得なしでFrontendが無効化を判定できるようにする。現行公開数値subsetだけではcrop／orientation差を判定できないため、全settings fingerprintをBefore keyとして使って毎slider再生成する実装を最終形にしない。

`ImageViewer`へRAW用Before画像入力とloading/errorを追加し、既存plain img部分のBefore／Afterを同じstage／transform内で切り替える。`documentKey`に画像種別やBlob URLを入れず、同じdocumentの切替はzoom／panを維持する。nativeが同じcrop／orientationで出力した両画像の実寸・aspectを検証し、同じ要求maxSideで揃える。寸法不一致を伸縮や別fitで隠さず比較を保留する。cropで実寸が変わる場合だけ両frameを再取得し共通fit／pan clampを更新する。

Before準備中はその状態を表示してAfterを維持し、準備完了後に比較する。Backslash一時表示、永続switch、JIS Originalキー優先、IME／入力／dialog／menu guardとフォーカスを既存registry経由で維持する。JPEGは従来 `AdjustedImage` のCanvas比較を使い、RAW入力を渡さなければ動作は変わらない。RAW Scope／Exportは有効化しない。

### 7. 推奨実装：JPEG個別ON/OFF削除（C4-E）

| 変更対象 | 実装する内容／維持する境界 |
|---|---|
| `AdjustmentSlider.tsx` とWB／Basic／Color／ColorGrading各Controls | 個別power・toggle props・個別OFFのdim表示を外す。Reset button／callbackは残す。RAWも共通部品から個別powerを受け取らず、Resetだけを接続可能にする。`actions=false`でまとめて消すとResetも消えるため使わない。JPEG controlsの順をカラー（temperature／tint／vibrance／saturation）→基本（exposure／contrast／highlights／whites／shadows／blacks）→独立Color Gradingとする |
| `AnshitsuPage.tsx`／`AdjustmentCategoryMenu.tsx`／`AdjustmentContextMenu.tsx` | 左カテゴリ順をカラー→基本→Color Gradingにする。旧WB／Colorを別々にtoggle・Resetしない。`whiteBalanceEnabled`と`colorEnabled`は一つの操作で同値更新し、1 History entryを作る。統合カラーResetは4数値を一操作で戻し、両fieldを同一状態に保つ。basic／grading toggle・個別Reset・copy／paste・focus復帰を維持する。個別slider menuのtoggleだけ削除し、カテゴリ／grading rangeのtoggleは維持する |
| `adjustmentNavigation.ts`／関連CSS／locale | 個別powerへのfocus探索・レイアウトを整理。category／range powerは残す。削除済みcontrolへのfocus退避経路を作らない |
| `editing.ts`／`editState.ts` | 新規 `toggleAdjustment` actionの生成・reducer操作を廃止し、新しいRecipeは全個別flag trueのまま。`effectiveAdjustments`から個別flagによる既定値代入を除き、カテゴリ／grading rangeだけをbypassに使う。統合カラーtoggle actionは既存の両fieldを一操作で同期し、統合color Resetを4数値の一操作としてHistory化する。History reducer／validator／compactorで既存 `whiteBalanceEnabled`・`colorEnabled` の変化を別カテゴリ操作として新規生成しない。Frontendのnon-default／edited判定も個別flagだけで編集ありとしないようBackendと揃える。Recipe型／version／16 flagの保存形状は残し、完全snapshotの等価性・History整合性検証は維持する |
| `adjustmentPipeline.ts`／Worker／`webgpuRecipe.ts` | 共有effective処理を使う現行境界を維持し、CPU・Worker・GPUで個別OFFを処理しない。画素式・stage順・processing versionは変更しない（UIとenabledポリシーの変更） |
| `backend/jpeg_renderer.py`／`edit_state.py` | rendererの個別OFF代入を除く。統合カラーの有効状態は既存2 flagsの単一カテゴリ方針へ揃え、フロントのeffective/render処理と同じにする。編集済み判定で個別flagだけのOFFを有効な編集とみなす依存も除く。Recipe v18の16 bool形状検証とSQLite schemaは維持し、Historyの数値・カテゴリ・cursor整合性検証は緩めない |
| `EditHistory.tsx`／`editClipboard.ts`／共有History整理処理 | 統合カラーON/OFF・Resetのlabelとundo／redo／jumpを一操作として表示する。既存の数値Reset・basic／Color Grading・paste Historyを維持する。過去履歴のmigration・互換や個別flag toggle操作の再生成を追加しない。copy／pasteは現行どおり数値のみとしenabled flagsはコピーしない |
| `thumbnail_generator.py`／Export経路／`webgpuRecipeCases.ts` | Backend renderer共有を確認し、個別OFFなしのCPU／GPU／Export／補正済みサムネイル一致を回帰対象にする。診断caseの旧「個別OFFでbypassする」期待も更新。cacheのRecipe version・DB schema・保存データを一括変換しない |

全個別flagをtrueへ書き換えるデータmigrationや、旧OFF状態を再現・救済するload処理は追加しない。保存済みfalseが来ても現像では無視するという新方針を両rendererへ適用する。Historyのbefore／afterやcurrentを一括書換えて新しい整合性問題を作らない。旧個別OFF由来のthumbnail cache救済・過去Export再生成も対象外。新規操作で個別falseを生成しないことと、flagを参照して画素をbypassする箇所が残らないことが受入条件である。

### 8. まだ設計判断が必要な事項

確定した最上部カラー統合・SQLite正本・As Shot・native Before・JPEG v18維持は再検討事項にしない。残る判断は次に限定する。

| 判断時期 | 課題と推奨案 |
|---|---|
| C4-B開始時 | API名／一覧pagination・許可kind・receipt ack項目の最終定義。4096 bytes制限のJSON helperは履歴一覧全件に足りない。推奨はページ単位（例20件）、固定label IDとbounded metadata、履歴metadataだけに限定した応答上限を定義。通常request 4 KiBは広げない |
| C4-C実装時 | As Shot値がnative適用範囲外またはreadback不一致となるfixtureの回復・表示。確定仕様は成功扱いしないこと。推奨は開始Settingsへの検証付きrollbackを行い、rollback不能ならdocumentをlockする。値をclamp／推測して成功にしない |
| C4-D開始時 | 最小MCP拡張のBefore key metadata、対応識別、既存Afterとの互換契約・固定ソースに対するpatchの配布方法。LightCraft版はv0.10.0固定のまま、変更済みbinaryをversionだけで同一視しない。release artifact／runtime検査を変えるなら当該期待値も確認 |
| C4-D実機受入 | native標準crop／orientationと両frame実寸、WebView2の表示色・比較切替待ち時間。自動fake画像テストでは実GPU／GUIと同じ結果を保証できない |

JPEGの履歴整理menu（clear／trim／compact／resetEdits）全機能をRAWへ移植することは今回の必須受入に含めない。RAWへ有効化するのはUndo／Redo／jumpと新操作の枝切りまで。ResetとHistory消去を結び付けず、未対応menuは理由付きで無効／非表示にする。

### 9. 実装区分・依存・受入条件

依存は **C4-B1→B2→B3→C4-C、C4-B3→C4-D、C4-Cの共通Slider整理と調整してC4-E、全体→C4-F**。C4-EのBackend画素方針は独立して準備できるが、共用Sliderの削除をC4-Cと重複実装しない。C3基盤は置換しない。以下は将来実装時のテスト計画で、今回実施した結果ではない。

#### C4-B：RAW History・Undo/Redo

| 単位 | 対象ファイル・責務 | 自動テスト範囲 | Windows実機・完了条件 |
|---|---|---|---|
| B1 永続契約 | `backend/raw_recipe_store.py`、`edit_store.py`、`storage.py`、`release/smoke-test.sh`。additive table・read validation・原子的writer・receipt・200件整理 | `test_raw_recipe_store.py`／`test_storage.py`とHistory追加テスト。v7以前からのupgrade、既存JPEG／Queue保持、append／jump／枝切り／prune、busy/full／commit rollback、同設定異cursor、saveId replay／異payload拒否。Smoke Testの変更SQL／Python assertionはfocused実行 | upgrade前の整合backup／復旧手順を確認。実DB操作は実装時の承認範囲で別管理。currentとcursorが常に同じ保存状態であることが完了条件 |
| B2 document／操作API | `backend/windows_raw_api.py`、`lightcraft_raw.py`、必要な `raw_controls.py`。gesture／target restore／History metadata、既存queue／owner／shutdown／保存receipt統合 | `test_raw_recipe_api.py`／`test_raw_recipe_restore.py`／`test_windows_raw_api.py`／`test_lightcraft_raw.py`。HTTP cancel、native未知／mismatch、DB失敗、commit後ack消失、外部CAS競合、世代変更、checkpointとHistory同期 | Undo／Redo後の保存・再openとエラー再試行。失敗時cursor成功表示なし、任意Settings／command公開なし、DockerへRAW route追加なし |
| B3 UI／gesture | `rawApi.ts`、`rawControls.ts`、`rawRecipeSave.ts`、`useRawDocument.ts`、`RawAdjustmentControls.tsx`、`AnshitsuPage.tsx`、`EditHistory.tsx`またはRAW表示分岐、`useAssetEdits.ts`のshortcut arbitration最小接続、必要なlocale | 既存raw系unit／hook、`useRawDocument.test.tsx`、`AnshitsuRawPreview.test.tsx`、`AnshitsuPersistence.test.tsx`、History／shortcut focused。長いdrag・500ms・数値Escape・begin重複・control変更・no-op枝保持・保存retry・close guard・200境界再生成 | pointer／数値／keyboard／wheelが各1履歴、Undo／Redo／jump・枝切り、200件保持とbaseline繰上げ、RAW↔JPEG、Gallery・通常終了・再起動でcursorとRedo保持。256超の累計操作を新世代で継続し、再生成で履歴を増減しない |

JPEG EditEntryにRAW Settingsを変換せず、表示用kind／label／数値だけを共用部品へ渡す。KelvinはRAW formatterを使う。shortcutは既存 `editShortcuts.ts`／formatterを使い、Filmstrip除外Undo優先とactive engine dispatchを1経路で仲裁する。RAW用第二listenerで同じPrimary+Zを処理しない。

#### C4-C：カテゴリON/OFF・個別／カテゴリ／All Reset

- 変更：`backend/lightcraft_raw.py`／`raw_controls.py`／`windows_raw_api.py`、Frontendの `rawApi.ts`／`rawControls.ts`／`useRawDocument.ts`／`RawAdjustmentControls.tsx`／`AdjustmentSlider.tsx`／`AnshitsuPage.tsx`／locale。最上部カラー4項目の統合、native allowlist、WB値とscaleまで照合するAs Shot処理、mutation budget、BのHistory writerへの操作登録を担当する。
- 自動テスト：native command payload・順序、OFF中の値保持／Reset、light／color section境界、WB mode・値・scale、As Shotと異なる6500／0、import_look分岐、正確にAs Shotへ戻せない場合のrollbackと失敗扱い、複合command途中失敗、1 History／Undo復元、200／256予算、save失敗guard。既存 `test_raw_controls.py` とraw adapter／API／Controls・Anshitsu focused testを拡張。
- Windows実機：最上部カラー→基本の順、カラー共通powerで4項目の見た目と補正が連動、OFF→ONで値保持、温度ResetとTint ResetがともにWB全体をAs Shotへ戻すこと、カテゴリ／All ResetのAs Shot、Reset→Undo→Redo、保存・再入場、200境界のResetを確認する。
- 完了：カテゴリ／Resetが1操作でSQLite保存・Undo可能。native readback全体を維持し、個別power／WB preset UI／History clearを追加しない。As Shot一致の条件と失敗経路をテストし、代替値を成功として受理しない。

#### C4-D：RAW Before/After・最小MCP拡張

- 変更：固定LightCraftの `crates/mcp/src/tools.rs`／`headless.rs` と関連MCP test（本工程で初めて変更）、GenzoRoom `lightcraft_raw.py`／必要な `lightcraft_mcp.py`・runtime能力検査／`windows_raw_api.py`、`rawApi.ts`／`useRawDocument.ts`／`ImageViewer.tsx`／`AnshitsuPage.tsx`／locale。画像取得・key・kind・Blob寿命・共通Viewerを担当。
- 自動テスト：拡張なしAfter互換／Before非対応、true flag伝達、native初期設定・crop／orientation・歪曲非転写、同key cache hit／寸法・世代変更miss、Before／After queue衝突、PNGサイズ／metadata不一致、decode中切替、URL解放、再生成後再取得。JPEG `ImageViewer.test.tsx`／`AdjustedImage`比較も回帰。
- Windows実機：初回Before生成と2回目cache切替、補正しても初期現像Before、同一位置・zoom／pan、Backslash／JIS、RAW切替／再生成／再入場、Before失敗時のAfter編集継続、拡張非対応binaryを確認。crop／orientation・歪曲はUI追加せずfixtureで標準動作を検証する。
- 完了：最初のPreview保存に依存せずnative Beforeが取得でき、After現在設定・History・保存状態を変えない。key更新／所有／寸法検証とJPEG比較回帰が成立し、1024を将来固定仕様として記載しない。

#### C4-E：JPEGカテゴリ統合・個別ON/OFF削除

- 変更：§7のFrontend Controls／Slider／category・slider menu／navigation／`editing.ts`／`edit_state.py`／`jpeg_renderer.py`／診断case・関連test／locale。カラーを最上部へ移しWBとColorの4項目・toggle・resetを統合、基本補正を次に置き、Color Gradingは独立させる。Recipe v18・16 bool・両category flag・JPEG table構造を維持する。RAW Bのadditive migrationとは独立。
- カテゴリ状態：`whiteBalanceEnabled`・`colorEnabled`のどちらも削除・改名せず、単一カラーtoggleが両方を同じ値へ更新する。以降これらを独立更新するactionを作らない。render上は2 fieldのANDを単一category状態として4項目へ適用し、操作を通じて両fieldを同期する。category resetは4数値を一つのHistory操作でresetし、両fieldを単一category状態へ同期する。個別Resetは各数値だけを変える。過去の異なるflag状態に対する互換性は設計しない。
- 自動テスト：`editControls.test.tsx`、`editing.test.ts`、`editClipboard`／History／`useAssetEdits`／`editState`、CPU pipeline／Worker／WebGPU recipe、Backend `test_jpeg_renderer.py`／`test_edit_state.py`／`test_thumbnail_generator.py`とExport focused。個別flagをfalseにしても個別bypassされず、category toggleは両fieldを同期、4項目すべてのON/OFFと一操作のReset／Undo／Redo／History jump、数値個別Reset・basic／grading toggle、paste・保存を確認。旧個別OFF期待だけを更新し、無関係のpixel goldenは変更しない。
- Windows実機：カラーが最上部・基本補正が次であること、4項目が一つのカラーON/OFFとResetを共有し、個別Resetは使えること、Color Gradingが別カテゴリであることを確認。コピー／ペースト・History・Before／After・Export／補正サムネイルを確認。NAS／Firefoxの既存JPEG回帰はユーザー確認へ残す。
- 完了：新しい個別falseや独立WB／Color category actionを生成しない。Recipe v18・16 flag・両category flag・SQLite schemaを保ち、過去状態のcompatibility／migrationなしで、Frontend／Backend renderer／Export／thumbnailが統合category方針に揃う。History・Before／After・copy/paste・個別ResetとColor Gradingは維持する。

#### C4-F：横断監査・回帰・実機受入

- 対象はB〜Eのdiffと依存境界、必要な `docs/architecture.md` の共有状態表・仕様追随、既存関連テスト。新機能や対象外工程を追加する区分ではない。
- 監査対象はnative→readback→History/currentのtransaction→ack→Preview、generation変更、gestureの残存、receipt再送／CAS、cursor-only dirty、複合Reset失敗、Before cache所有、JPEG renderer／thumbnail／Exportの方針一致、認証・4 KiB request制約、構造化診断のprivacy。
- 診断は既存loggerへoperation開始／完了・readback不一致・保存失敗／再送・stale破棄・再生成・Before cache詳細を必要なlevelで追加する。operation ID／saveId／revision／cursor／件数／generation／bytes／固定errorCodeだけを用い、Settings／History本文・画像・path・cookie・任意文字列を出さない。終端失敗をoperation errorとして記録し、logger失敗で処理を失敗させない。
- 自動確認は変更に対応するFrontend／Backend focused統合とTS check／production build、`git diff --check`。B／Eは保存・renderer共有を跨ぐため両側を確認する。full suiteはfocusedで残る具体的な不足を報告してから判断し、成功済みの無変更範囲は繰り返さない。フルDocker Smoke Testは行わず、schema等の変更assertionをfocused実行する。
- Windows実機受入はユーザーが実施する。混在Filmstrip→長いRAW gesture→Undo／Redo／Reset→200再生成→Before比較→保存失敗retry→通常終了／再起動、原本／engine不一致、実GPU／RSS／待機時間、JPEG Export／サムネイル、NAS／Firefoxをチェックする。自動fake成功と実機成功を分けて記録する。
- 完了条件はB〜Eの受入・未決定事項が解消され、保存整合性とJPEG回帰の未解決重大問題がなく、実機未実施項目が明示されていること。実機の未確認を自動テストで確認済みとはしない。

### 10. C4-Aの完了範囲

今回完了したのは、接続箇所・保存transaction／失敗境界・UI方針・実装区分の調査と本節への記録である。新規memory snapshot store、native History同期、C3再実装、JPEG旧OFF移行は提案しない。C1〜C3完了記録とnative調査書を保持し、README／CHANGELOG／architectureは今回変更しない。

検証は文書差分の確認と `git diff --check` のみ。テスト／build・migration・実データ操作・LightCraft変更・実機操作は未実施。Commit／Push後はC4-Aで停止し、C4-B以降へ進まない。

### C4-A最終補正（2026-10-23、確定仕様）

- RAW温度／Tintのいずれの個別ResetもWB全体をAs Shotへ戻す。カテゴリReset・All ResetもAs Shotを確認する。source値と完全readbackが一致しない場合は成功扱いせず代替値を推測しない。全体でHistory 1操作としUndo可能にする。
- RAW Historyは最大200操作。上限超過時に最古stepから整理しbaselineを繰り上げる。current recipe・cursorを同一transactionで整合させる。上限はschemaへ固定せず、後日の件数変更・手動History整理／圧縮に対応できる構造にする。JPEGの手動整理機能をC4に実装しない。
- JPEGもカラー（温度／Tint／自然な彩度／彩度）を最上部、基本補正を次に統合し、Color Gradingは独立する。統合カラーのtoggle／Resetは一操作とする。`whiteBalanceEnabled`／`colorEnabled`をRecipe v18・SQLite schema内に保持し、render時は統合状態として扱い、新しい操作では両fieldを同期する。個別ON/OFFを廃止し、個別ResetとJPEG History／Before・After／Export／補正済みサムネイルを維持する。過去状態の互換・migrationは設計しない。

## Phase 1C-C4-B1 実装結果（2026-10-23）

開始HEAD `3c66494ad24261690550d704339ef25cd372912c`、`feature/lightcraft-integration`、cleanから実装。対象はBackend永続化層のみ。C4-Aの確定仕様とC1〜C3完了記録を保持し、LightCraft操作・Windows RAW API・Frontend／UIは未接続である。

### schema v8・共有状態

既存migration chainにv7→v8を追加した。旧JPEG table、RAW current recipe、recipe receipt、Queue／Export tableは変更しない。起動時 `storage.validate_existing_database()` とrelease smokeの実SQLite assertionもv8へ合わせた。

| Table | 確定した構造・不変条件 |
|---|---|
| `asset_raw_histories` | 既存6項目identityの複合PK／current recipeへのFK、完全 `baseline_settings_json`、`history_cursor`、最新History receiptへの `last_save_id`。cursor 0はbaseline、それ以外はpositionに対応。current recipeと選択snapshotは必ず一致 |
| `asset_raw_history_steps` | 同identity＋連続positionのPK、global UNIQUEなstable UUID `step_id`、固定kind・bounded `metadata_json`、完全after settings、UTC作成日時、作成receiptへの `save_id`。beforeを重複保存しない |
| `raw_history_saves` | 同identityとrecipeへのFK、既存recipe receiptへのPK／FK `save_id`、request hash／bounded request JSON、result hash／bounded ack JSON、予約済みstep UUID、recipe revision／更新日時。snapshot本文を持たず、枝切り／pruneで削除しない |

保持上限はコードの `HISTORY_LIMIT = 200`。schema CHECKには固定しない。有効append時だけRedo枝を切り、超過した最古stepのafterをbaselineへ繰り上げ、残存UUID／順序を維持してpositionとcursorを補正する。current recipe、両receipt、parent、step変更を一つの `BEGIN IMMEDIATE` 内で保存する。既存write部分をconnection受取 `_write_recipe()` に抽出し、別transactionから `put_raw_recipe()` を呼ばない。

### 内部Python保存API・C4-B2への契約

- `get_raw_history(identity, initial_settings=None)`：current recipeとHistoryを同じread transactionで検証して返す。未保存なら任意の初期readback、C3保存済みなら現在保存値をbaselineとする読み取り用viewを返す。Historyのない写真を読んでもHistory rowを作らない。
- `initialize_raw_history(identity, expected_revision, save_id, settings)`：現在設定のbaseline checkpoint。架空の編集stepは作らない。
- `append_raw_history(identity, expected_revision, save_id, settings, kind=..., metadata=..., step_id=..., baseline_settings=...)`：確定snapshotから1操作を追加。未保存RAWの最初のappendには編集前readbackをbaselineとして渡す。step UUID省略時はsaveIdを使用する。
- `move_raw_history_cursor(identity, expected_revision, save_id, settings, target_step_id=...)`：Undo／Redo／jumpの保存境界。stable UUIDまたはbaselineの `None` を指定し、渡された確定readbackとtarget全設定が一致した場合だけ保存する。cursor移動はstep追加なし。同じ設定でも異なるcursorへの移動は保存可能。
- writerは `{ack, current, replayed}` を返す。`ack`は元requestの結果revision／cursor／件数／step ID／fingerprint、`current`は今の保存状態metadata。過去ackを現行cursorとして適用してはいけない。再送は同一saveId／expectedRevision／操作／step ID／Settings／baselineを保持する。

kindは `control`／`controlReset`／`sectionToggle`／`sectionReset`／`allReset`。metadataはC2の10 control IDまたはlight／color section ID、toggle boolだけを許可し、1 KiB以内とする。receipt JSONは各4 KiB以内、snapshotは既存256 KiB／深さ32／node 32,768等のvalidatorを共用する。全identityを正規化・分離するが、実engineとの互換性やreadback由来の証明は引き続きadapter callerの責務である。

no-opはstepを増やさずRedo枝も切らない。ただし受理したsaveIdを別payloadへ使い回せないよう、保存checkpointとしてrecipe revisionとreceiptを一度だけ増やす。同一request再送は増やさない。History step UUIDはprune／枝切り後もreceiptで予約され再使用できない。

Historyなしの既存 `put_raw_recipe()` は入力・出力・競合・古いsaveId replayの契約を維持する。History初期化後は同一current設定のcheckpointだけを許可し、新しい異設定のrecipe-only保存は `StoreConflict(raw_history_requires_operation)` で拒否する。履歴snapshotの上書きや架空stepでの補填をしない。C4-B2はHistory writerへ結線する必要がある。

保存済みデータはSettings、連続position、cursor、UUID、allowlist metadata、step作成receipt、最新receiptの全履歴fingerprint、current選択snapshot一致まで検証する。receiptはrequest／result hashと既存recipe receiptを照合する。破損は `StoreUnavailable(persistence_unavailable)`、History入力不正は `InvalidRawHistory(invalid_raw_history)`、Settings入力不正は既存 `InvalidRawRecipe`。不整合を空履歴扱いしたり自動修復したりしない。

### テスト・限定監査・残る境界

repo `.venv` Python 3.14、cwd backendで次のfocused検証を実施した。通常sandboxのpytest TEMP作成失敗はテストsetupの環境制限であり、同じPythonの権限付き実行で確認した。

- `test_raw_history_store.py`：最終92件成功。v1〜v7→v8・migration失敗rollback、既存列／データ保持、遅延baseline、初期化、append／Undo・Redo・jump、no-op／同設定異cursor、枝切り、200／201件、baseline繰上げ・連続position・UUID保持、prune／枝切り後の過去ack、異payload／保存domain衝突、並行writer、破損のfail-closedを検証した。
- C3-A〜D関連保存と依存境界：`test_raw_recipe_store.py`、`test_raw_recipe_api.py`、`test_raw_recipe_restore.py`、`test_storage.py`、`test_windows_raw_api.py`、`test_raw_controls.py`、`test_edit_state.py`、`test_export_queue.py`の266件＋41 subtests成功。既存recipe-only保存・復元／Autosave保存API、JPEG History／Queueの回帰を確認した。
- 実SQLite writer lock／SQLITE_FULLに加え、recipe／両receipt／parent／step／prune／position更新／commitの各失敗を注入し、current・cursor・baseline・receiptがすべて元状態へrollbackすることを確認した。release script内の実SQLite assertion blockを一時v8 DBへ限定実行した。
- 限定監査ではtransaction境界、古いackの扱い、recipe-only checkpoint、pruneとbaseline、receipt破損、migration rollbackを点検。prune済みUUID再利用の拒否、cursor-only／初回insert／再番号付け失敗、同一設定cursor差と再送の回帰を追加し、最新receiptと選択Settings fingerprintの照合も補強した。未解決High／Mediumはない。

`git diff --check`で差分の空白を確認。Frontendテスト／build・全Backend suite・フルDocker Smoke Test・実LightCraft／GPU／Immich・実機DB操作は行っていない。テストDB以外へmigrationは実行していない。実profileのv8 upgrade前には整合backupを取り、v7以下への復帰はbackup復元で行う。既存schemaのdowngradeは提供しない。

C4-B1で停止する。HTTP API、gesture／readback操作owner、UI、通常編集からのHistory登録はC4-B2／B3へ残す。RAW Export／サムネイル、JPEGカテゴリ統合・個別ON/OFF削除も今回実装していない。

## Phase 1C-C4-B2 実装結果（2026-10-23）

開始HEAD `cb98ec3be266353f0a5138bcefafe29d363ca800`、`feature/lightcraft-integration`、cleanから実装。上のB1完了時点の未接続記述に対し、本節を現行のBackend接続仕様とする。C1〜C3とC4-A／B1の記録は保持した。

### Windows操作APIとreadback・保存境界

既存Windows専用routerの `/api/raw/documents/{handle}` に以下を追加した。Docker routerへ追加せず、LightCraft v0.10.0と既存owner lock／認証・Host／Origin検証を使用する。

| Method／suffix | 確定した契約 |
|---|---|
| `GET /history` | History/currentの整合性を検証し、cursor・件数・選択UUID・SQLite revisionとstep UUID／kind／metadata／createdAtだけを返す。`offset=0`、`limit=20`が既定、1ページ最大20件。offset上限は保存層の保持上限定数を共用。このendpointだけ応答上限16 KiB、他は4 KiBを維持する |
| `POST /history/initialize` | 初回gesture前の明示的なHistory利用開始。完全readbackからbaseline checkpointを保存しstepは増やさない。既存Historyは保持。既存Recipeとnativeが異なる初期化は拒否し、C3保存を先に完了させる |
| `POST /history/commit` | 編集操作の確定だけを受理し、完全readback・所有権／revision／fingerprintを検証後、B1 appendでHistory/currentを同時保存。B2は `kind=control` とallowlist内の `metadata.control` 1項目だけを受理する |
| `POST /history/undo`／`redo`／`jump` | cursorからstable UUIDを解決する。jumpは `targetStepId` UUID、baselineは `null`。保存snapshotを内部取得し既存 `restore_persisted_settings()` で全設定適用・readback一致後、B1 moveでcurrentとcursorを同時保存。新stepは作らない |
| `POST /history/recover` | 明示的な未確定native変更の破棄。最新の検証済みSQLite currentへ復元し、DB revisionが変化していないことも確認する。DB書込／receipt／History stepを作らない。保存Recipeがなければ拒否し、初期値を推測しない |

GETの所有権headerは `X-Raw-Workspace`／`X-Raw-Generation`／`X-Raw-Token`。POST共通bodyは `workspaceId`／`generation`／`documentToken`／`documentRevision`／`expectedRecipeRevision`／`settingsFingerprint`、recover以外はUUID `saveId` も必須。commitは `kind`／`metadata`、jumpは `targetStepId` を追加する。それ以外のfield、任意Settings本文・native commandは受理しない。request上限4 KiBを維持し、snapshot本文・source hash／path・native PhotoIdは応答へ出さない。

中間controls更新は従来どおりnativeへ適用するがHistory保存は行わない。確定commitだけで有効変化1件につき1stepとなる。no-opでRedo枝を切らず、Undo／Redo／jumpはUUIDとbaselineを使用する。同一設定でcursorだけが異なる移動も保存対象。`edit.undo`／`edit.redo`／`history.restore` は呼ばない。

### 保存整合性・共有状態と失敗回復

| 状態 | owner・更新条件・不変条件 |
|---|---|
| native `revision`／`settingsFingerprint`／mutationAttempts | 既存adapterとdocumentがreadbackで更新。SQLite revision／cursorと混同しない。追加した `confirmed_settings()` は最後の確定snapshotを観測するだけでnativeへ送信しない |
| SQLite `recipeRevision`／`recipeFingerprint`・cursor／UUID | B1保存層が正本。mutation応答で最新状態を再読込し、immutableな元 `ack` とは別に返す。旧ackを現在状態として適用しない |
| `_history_identity`／`_history_initialized`／`_history_enabled` | API ownerがopen時に6項目identityとDB初期化状態を取得。利用開始はdocumentごとに明示する。History保存済み写真を旧C3 clientが開いた場合、初期化等で契約を確立するまでcontrolsを拒否する |
| `_history_save` | active documentの未確定操作を最大1件保持。要求／saveId／対象UUID／readback／stageを固定して再送する。一時的な操作ownerであり、別のHistory／snapshot保管庫を作らない |
| `_history_tasks`／`_history_draining` | pending作成前も含む受理済みHistory要求を追跡。HTTP待機側cancel後も処理を所有する。終了は新要求を止めて受理済み処理を待ち、保存checkpoint一致後だけnativeを解放する |
| `_recipe_save.settled` | 既存C3保存の結果不明と既知の結果を区別。結果不明なら同一C3要求を解決するまでHistory開始を拒否。書込なしが確定した `raw_history_requires_operation` 拒否は、正しいHistory commitを妨げない |

native適用／readbackに失敗した場合、DB cursor/currentを更新せずdesync保護を維持する。readbackが要求revision／fingerprintと異なる新規操作は拒否し、Undo対象を適用して未確定変更を隠さない。native状態がdesynchronizedなら、最後の確定cacheがDBと等しくても保存済み扱いしない。

SQL busy／full／commit失敗・保存結果不明ではimmutable要求と適用済みnative状態を保持し、controls・Recipe保存・releaseを拒否する。同一saveId／同一bodyによる再送でreceiptを確認し、存在すればnative適用なしで元ackと最新metadataを返す。存在しなければ同じB1 writeを再試行する。異payload・別domain／identityへのsaveId再利用を拒否する。CAS競合は自動上書きせず、最新SQLite revisionを確認した明示recover等で解決する。`/settings` resyncだけで未確定保存を消さない。

応答の `historyPending`／`nativeState`／`nativeMatchesRecipe` を併せて確認する。過去のackだけでは現在nativeが保存済みとは判断できない。互換WB scale省略データは、adapterによる完全な正規化readbackの一致を確認しつつ、保存snapshotの元表現を保持する。ack内の保存fingerprintとdocumentの正規化fingerprintを混同しない。

B1保存APIにはoptional `request_fingerprint` と読み取り関数 `get_raw_history_save()` を最小追加した。理由は、枝切り／prune後も失われた旧snapshotを再構成せず、正確なHTTP再送をreceiptで検証するためである。action／opaque handle／全要求fieldのdigestだけをreceiptに記録し、bodyやpathは保持しない。既存B1呼出し・旧receiptの読み取り、schema v8、CAS／receipt／rollback／200件保持の実装を維持する。Windows側へ保存transactionを複製していない。

### C3共存・B3への条件

History未初期化の通常C3 documentは従来のrecipe-only保存・終了経路を維持し、自動的にHistory rowを作らない。初期化後のrecipe-only保存は同一current設定のcheckpointだけを許可する。異設定をB1が拒否した場合に架空stepや自動上書きで成功扱いしない。

History documentの写真切替・Session再生成・通常終了は、未確定保存なし、native同期、最新SQLite revisionと設定の一致を確認してから解放する。C3-Dの200 soft threshold／256 hard limitは変更しない。History復元も既存adapterのmutation attemptとして計上し、再生成による復元をstepにしない。再openはcursor／UUIDを維持するが、新しいgeneration／tokenでのみ操作できる。

B3は最初のgesture前にinitializeし、gesture終端ごとに1回だけcommitする。失敗時はsaveIdとbodyを固定して再送し、最新metadataが保存済みになるまで次の変更・切替・再生成・終了を進めない。従来の5秒recipe-only保存を異設定History保存の代用にしない。recoverは未確定変更を捨てる明示的な操作として接続する。Frontend／History UIの接続、カテゴリON/OFF・Reset、Before/AfterはそれぞれB3／C／Dに残す。

### 自動テスト・限定監査

repo `.venv` Python 3.14、cwd backend、Fake LightCraftと一時SQLiteでfocusedテストを実行した。通常sandboxのTEMP制限に対しては同じ実行環境の権限付きpytestを使用した。

- 既存依存境界のfocused回帰：History store、RAW recipe store／API／restore、Windows RAW API、controls、adapter、Windows local、JPEG edit state、Export Queueで429件＋41 subtests成功。
- 監査修正後のHistory API／store・C3保存API／restore・Windows RAW API／controls：223件成功。このうちHistory APIは33件、storeは100件。最後の共通保持上限定数利用への変更後、API33件を再確認した。これらの実行範囲には重複がある。
- 新規APIテストで、lazy GET・応答制限／認証／所有権、確定操作と中間更新、Undo／Redo／jump／baseline、同設定異cursor、Redo保持／枝切り、旧ack再送、異payload、native適用／readback失敗、実SQLite lock／SQLITE_FULL／commit失敗／commit後ack消失、CAS外部writer、HTTP cancel、pending作成前／native適用中／DB保存中の終了待機、200 mutationを跨ぐ2回の再生成、旧generation／token／別asset、legacy WB表現を検証した。
- 限定diff監査で、所有権・readback→DB→ackの順序、receipt再送、既存C3との競合、終了・解放、private情報／ログ境界を点検した。既知のRecipe-only拒否で操作を詰まらせないこと、desync中の誤った保存済み判定、Undo直前readback変化の拒否、初期化受理直後の終了待機を補強し、関連テストを再実行した。未解決High／Mediumはない。

`git diff --check`成功。schema／migration／release smokeの変更は不要。Frontend・LightCraftソース・JPEG renderer／Recipe／History・RAW Export／サムネイル・README／CHANGELOGは変更していない。Frontend check／build、全Backend suite、フルDocker Smoke Test、実LightCraft／GPU／Immich／実機DB・ブラウザ検証は未実施。通常終了の保存待機を自動確認したが、強制process終了時の未確定native状態の保持は保証しない。

設計書とarchitectureを更新しCommit／Push後、C4-B2で停止する。実機のGPU／Windows UI・B3接続後のgesture／Autosave／再生成の受入は後続でユーザーが実施する。

## Phase 1C-C4-B3-1 実装結果（2026-10-23）

開始HEAD `4274f92511ec538be7679c925f30031ac2d7ad48`、`feature/lightcraft-integration`、cleanから実装。B2末尾のFrontend未接続記述に対し、本節を保存coordinatorの現行仕様とする。History一覧・Undo／Redo UIはB3-2へ残す。

### 初期化・gestureと既存保存ownerの統合

`rawApi.ts` にB2 initialize／commitの型と `saveRawHistory()` を追加した。4 KiBのJSON応答制約と既存request処理を利用し、所有権・native／DB revision・fingerprint・History metadata・元ackを検証する。Frontendから送るのは既存identity、native revision／fingerprint、expected recipe revision、saveId、commit時のcontrol IDだけで、DevelopSettingsを取得／保持／送信しない。

`useRawDocument` の既存 `ownership` queue、`RawControls` と `RawRecipeSave` を再利用する。open→初期readback／Preview→coordinator設置後、同じqueueへinitializeを1回だけscheduleし、成功までRAW 10項目の編集をlockする。未保存／既存Recipe／既存HistoryのいずれもBackendの確定値をbaselineとして扱い、既存step／cursorを保つ。初期化不一致・保存失敗は未保存のままRetry対象とし、編集を始めない。再生成でdocumentが変わった場合は、新ownerをinitializeする。

`RawAdjustmentControls` は共通 `AdjustmentSlider` のbegin／change／commitへcontrol IDを渡す。Slider本体の確定境界やJPEG処理は変更していない。pointer終了／cancel、数値Enter／blur／Escape、keyboard／wheel 500 ms inactivity、slider unmountを確定境界とする。同じcontrolへのbegin重複は一操作にまとめ、beginなしchangeも受理する。

操作中は既存150 ms debounceでnativeへ反映する。終端は最後のdesiredをflush→同じqueue上のbarrier→native/readback確定確認→History commit→ackの順。中間readbackでstepを追加しない。before／afterの全Settings比較・no-op時のRedo保持はB1へ委ね、Frontendは中立な確定intentを渡す。別controlへ移る場合は、前操作の保存ack後に次controlを適用する。

| 共有状態 | owner・更新条件・不変条件 |
|---|---|
| `RawRecipeSave.initialized` | document単位の利用開始。B2応答の所有権とcurrent一致を検証するまでfalse。新generationには引き継がない |
| `gesture` | control IDと開始時の確定fingerprint。保存済みbaselineと一致する開始状態を識別し、同じcontrolのbeginを繰り返しても置換しない。ackまで未確定／dirty |
| `handoff` | 隣のcontrolへの未送信値1件と終端flag。前操作のackまでnative操作を開始せず、失敗時もimmutable要求の後ろに保持。切替で入力をfreezeしても既に受理したintentは確定する。snapshot列や第二queueではない |
| `retryRequest` | C3からの現在操作1件のslotをRecipe／Historyのunionへ拡張。History利用時はaction／control／saveId／native revision・fingerprint／expected DB revisionを固定し、現在UI documentをcopyする。失敗を理由に要求を書き換えない |
| `revision`／`savedFingerprint`／`lastSaveId`／`dirty`／`saving`／`error` | 既存保存coordinatorが管理。未初期化・gesture・handoff・未確定要求はdirty。request処理中／error時に次のgestureを許可しない。最新readbackとcurrent metadataの一致後だけcleanにする |

History commitがcurrent Recipe保存を兼ねるため、History利用時は5秒Recipe-only Autosaveをscheduleせず、別PUTも送らない。既存C3単独モードの5秒Autosave・CAS再同期・immutable retry実装は維持し、別保存queue／非active写真snapshot storeは追加していない。

### 失敗・切替・終了・200 mutation

保存失敗／結果不明ではnative編集結果とimmutable要求を保持し、既存保存失敗表示とRetry／Stayへ接続する。Retryボタンは保存lock中も利用できるが、次のgesture・切替・通常終了・再生成は許可しない。Stayだけで未確定保存を解除しない。同一saveId／bodyの再送だけを行い、CAS競合に対する自動rebase・自動破棄は行わない。B3-1では専用recover／破棄UIを追加せず、再送で解決しないnative／current不一致は失敗のまま保持する。

clean判定は元ackの受信だけで行わない。現owner／native revision／fingerprint、`historyPending=false`、`nativeState=synced`、`nativeMatchesRecipe=true`、current recipe fingerprint、最新recipe revision／cursor／件数／選択UUIDとackの一致がすべて必要。古いdocument／generationの応答や、同じ旧ackが返るだけの不整合応答で保存済みにはしない。

`prepareSave()` は既存所有権guardを使い、入力freeze→native retryのqueue完了待ち→controls settle→History保存ack→受理済みhandoffを含むclean確認まで待つ。RAW→RAW／JPEG、Gallery、Filmstrip除外、Windows通常終了からの呼出しは維持する。native readback失敗では再同期を待ってから要求を作る。Previewだけの失敗なら、既に検証済みreadbackを保存可能とする従来C3の区別を保つ。

C3-Dの200 soft／256 hardと再生成ownerを再実装せず、gesture中の200到達では既存holdで最終desiredを保持する。gesture終端または `prepareSave()` のpauseで最終値をflushし、History保存成功後に限り既存release／reopenへ進む。再生成自体をstepにしない。UI用History再取得・cursor表示はB3-2に残す。

sliderのlate unmount callbackはclosureのasset／generation／tokenで次documentへの送信を拒否する。hook自体の予期しないunmountでは旧ownerの最終保存を既存queueへ先に置き、成功後だけcleanup／releaseする。未確定ならreleaseを拒否し、新documentへ旧ackを反映しない。通常の切替はunmount前のguardで失敗を捕捉する。ブラウザ／OS強制終了で最後の通信が完了する保証は従来どおりない。

### テスト・限定監査

Frontend focused回帰は `rawApi`／`rawControls`／`rawRecipeSave`／新規 `rawHistorySave`／`useRawDocument`／`AnshitsuRawPreview`／`AnshitsuPersistence`／`editControls`／`useAssetEdits` を対象とした。通常sandboxのVitest一時変換ファイルENOENTに対しては、同じテストを権限付きで再実行した。

- 初回focused 9ファイル356件成功。監査修正後は影響範囲のRAW 6ファイル116件成功（実行範囲に重複あり）。隣controlを保持したまま切替待機に入るケースと、ackとcurrentのcursor不一致も最終確認した。
- B2 Backend契約 `test_raw_history_api.py`：Python 3.14、Fake LightCraft／一時SQLiteで33件成功。Backendソース・schemaに変更はない。
- `npm run build`（`tsc --noEmit` とVite production build）成功。500 kB超chunkの警告は残る。Frontend全suite／全Backend suite／Docker Smoke Testは実行していない。
- 新規／更新テストは未保存・既存Recipe・既存Historyの初期化と失敗lock、全10 control ID、長いpointer dragとcancel、数値Enter／blur、keyboard／wheel 500 ms、category unmount、begin重複／beginなしchange／隣controlの待機、no-opとRedo保持、gesture中5秒経過でPUTなし、revision更新、同一要求再送・未知結果・旧ack、native retry、切替／通常Windows終了／200 mutationでの保存待機、旧owner応答とhook unmountを確認した。JPEG保存／共有Slider・RAW Preview／C3単独Autosaveも回帰対象とした。
- 限定監査では初期化前の入力、重複／欠落、二重保存、pending保持、queue deadlock、切替／終了／再生成、stale owner、JPEG境界を確認した。200到達中の終端イベントなし切替におけるhold解除、native retry前の古いerror参照、隣controlの受理済みintent保持、Previewだけの失敗と保存失敗の区別を補強し、関連テストを追加した。

監査修正後もTypeScript typecheck／production build成功。未解決High／Mediumなし。`git diff --check`成功。実LightCraft／GPU、Windows実機UI、ブラウザ動的確認は未実施。RAW History一覧・Undo／Redo／jump UI、カテゴリON/OFF・各Reset・Before/After、JPEGカテゴリ統合は変更していない。README／CHANGELOG・LightCraft・SQLiteも変更していない。

Commit／Push後、C4-B3-1で停止する。

## Phase 1C-C4-B3-2 実装結果（2026-10-23）

開始HEAD `13e64439bd7f249c23a12d445b7d0a1daf625aae`、`feature/lightcraft-integration`、cleanから実装。ユーザーからB3-1のWindows実機における補正値保存・復元の正常動作を確認済みと報告された。本節はB3-1末尾のHistory UI未接続記述を更新するもので、過去のC1〜C3／C4-A／B1〜B3-1完了記録を保持する。B3-2の実機操作を今回実施したという意味ではない。

### Frontend API・History表示

`rawApi.ts` に `readRawHistory(doc, offset)` とHistory metadata／step型を追加し、既存 `saveRawHistory()` をundo／redo／jumpにも拡張した。GETはworkspace／generation／documentToken headerを送って `offset`／`limit=20` を指定する。この応答だけ16 KiB、他JSONは4 KiBのまま。owner／native revision・fingerprint、ページ件数・cursor・selected UUID、kind／metadata allowlist、timestamp、UUID重複を検証し、返却値から表示契約外のfieldを除外する。完全DevelopSettings・source path／content hash・PhotoIdはFrontendへ持ち込まない。

既存 `EditHistory` のJPEG固有description／Recipe型は保持し、共通の `HistoryList` へ表示row（ID・position・description・日時）を渡す形にした。`RawEditHistory` はB2 metadataだけから同じ表示rowを構築する。最新順、undone／current表示、`aria-current`、行buttonと末尾baselineを共用し、RAWをJPEG Recipe／EditEntryへ変換しない。JPEGのcontext menu・手動履歴整理は維持し、RAWでは追加しない。

RAWはkind／controlのローカライズ名、操作日時、cursor／全件数、現在選択行とbaselineを表示する。温度はKelvinの `K` を明示し、Tint等の現在値表示は既存RAW formatterを維持する。B2 metadataにbefore／after値はないため、相対温度や架空の数値差を表示しない。

初期取得は現在選択stepを含む20件境界の1ページ、baseline選択時は最新ページとする。「前の20件」「後の20件」で必要なページだけ追加し、最大200 metadata rowまで表示可能。commit時は枝切り／pruneに備えて1ページを更新する。Undo／Redo／jumpは既存cacheを使い、選択stepが範囲外になった場合だけ対象ページを取得する。毎回全200件を再取得しない。再open／Session再生成後もSQLite metadataから選択pageとRedo範囲を復元する。

### coordinator共有状態・移動の保存順序

| 状態 | owner・更新条件・不変条件 |
|---|---|
| `RawRecipeSave.history` | B2のack／current一致後に更新するcursor／length／selected UUID。SQLiteが正本であり、Frontendでは移動を予測しない |
| `steps`／`historyOffset`／`historyLoading`／`historyError` | 同じcoordinator内の最大200件の表示metadata cache。ページ結合はrecipe revision／fingerprint・cursor／length／selected UUID一致が必要。snapshotや別の永続履歴を保持しない |
| `moveIntent` | 先行gestureの確定前に受理したaction／target UUIDだけ。gesture保存失敗時もintentを保持する。RPC送信時には既存 `retryRequest` slotへ移し、別のretry機構を作らない |
| `moving`／`historyOperation` | 重複入力を防ぐlockと `prepareSave()` が待つ完了fence。同じownership queueの保存処理を待つだけで、第二queue／dispatcherではない |
| `retryRequest` | B3-1の単一immutable要求をundo／redo／jumpへ拡張。native revision／fingerprint、expected SQLite revision、saveId、action／UUIDまたはbaseline nullを固定して再送する |

移動は入力lock→最終desired flush→既存queueでgesture readback／commit ack→移動可能範囲とtarget UUID再確認→B2 undo／redo／jump→native適用・readback・DB cursor更新ack→最新controls／保存revision／fingerprint／History metadata採用→Preview更新の順。全体を一つの既存queue保存処理へ同期的に予約し、受理直後のunmount cleanupが途中へ割り込まないようにした。

baselineは `targetStepId: null`、行選択はstable UUIDを送る。positionは表示と行選択の対応にだけ使用する。先行gestureの有効commit後に表示cacheから外れても、選択UUIDが削除されたとは判断せず同じUUIDをBackendへ渡す。枝切り／pruneで実際に消えた対象への初回 `409 raw_history_target_missing` はB2のnative適用・receipt作成前の既知の拒否なので、そのtarget要求だけを解除し、保存済みgestureを保って再取得・再選択を案内する。別position／baselineへ置き換えず、結果不明の保存へこの例外を適用しない。Redo可否も先行commit後に再評価する。Undo／Redo／jumpそのものを通常commitとして追加しない。同一設定でnative revisionが変化しないcursor移動も、保存revisionと選択metadataに従って正しく採用する。

移動失敗・保存結果不明ではimmutable要求と旧controls／cursorを保持し、編集・他のHistory操作・切替・終了・再生成を止める。元ackだけでは採用せず、`historyPending=false`／同期native／`nativeMatchesRecipe=true`／最新recipe・選択metadataとackの一致を検証する。既存Retry／Stayを使い、同一saveId・bodyを再送する。先行gesture保存だけが失敗した場合も、Retryでその保存を解決してから受理済み移動へ進む。黙った破棄・自動rebase・別snapshot上書きは追加しない。

metadata GETだけの失敗はDB保存失敗と区別し、既存cacheを残して一覧取得エラーを表示、History操作を無効化する。再取得buttonはGETだけを行う。保存済みcursorの採用後、Preview／decodeだけが失敗してもDB・cursorを巻き戻さず、既存RAWエラー／Preview retryで扱う。

### shortcut仲裁・切替・200 mutation

`useAssetEdits` の既存単一keydown handlerに現在engineへのcallbackを追加した。Filmstrip除外Undo→RAW History→既存JPEG dispatchの順で仲裁し、RAWが選択されたイベントをJPEGでも二重処理しない。処理中／非対応RAWでは操作を開始せず、そのイベントをRAW側で扱う。registry bindingとPrimary修飾、native入力・IME・repeat・defaultPrevented・modal等の抑止条件は維持した。新しいglobal shortcut handler／hard-coded command matchingを追加していない。RAW編集でも既存のworkspace edit境界を通して除外Undoを失効させる。

`prepareSave()` はHistory完了fenceを待ってから従来のsettle／保存guardへ進む。RAW↔RAW／JPEG、Gallery、Filmstrip除外、通常Windows終了の既存呼出しを維持する。History未確定のままrelease／再生成せず、C3-Dの200 mutationに到達した確定移動は保存・Preview処理完了後に既存再生成へ進む。再生成でstepを作らず、再open後にSQLiteからcursor／Redo範囲を読み直す。asset／handle／generation／tokenと既存frame検証により旧ownerの応答を新documentへ反映しない。

### テスト・限定監査・停止範囲

- Frontend focused 14ファイル654件成功：`rawApi`、`rawControls`、`rawRecipeSave`、`rawHistorySave`、`useRawDocument`、`AnshitsuRawPreview`、`AnshitsuPage`、`AnshitsuPersistence`、`useAssetEdits`、`editControls`、`editShortcuts`、`AnshitsuClipboard`、`AnshitsuExportQueue`、`Filmstrip`。監査修正とKelvin／Tint表示テスト追加後は影響範囲のRAW 6ファイル153件成功（実行範囲に重複あり）。
- Backend `test_raw_history_api.py`：repo Python 3.14、Fake LightCraft／一時SQLiteで33件成功。metadata、native restore／readback、cursor保存・SQL失敗・receipt再送の既存契約を確認。Backendソース・schemaは変更していない。
- TypeScript `tsc --noEmit`、Frontend production build成功。FilmstripテストのReact `act` warningと500 kB超chunkのbuild warningは残る。成功件数にskip／失敗はない。全Frontend／Backend suite・Docker Smoke Testは実行していない。
- 新規／更新テストは、未編集baseline・保存済み履歴／日時／選択、20件単位・200件・21件端数・選択page復元、Undo／Redo／任意UUID／baseline、境界無効化、同設定異cursor、移動後controls／Preview、Redo保持と有効commit時だけの枝切り、先行gesture確定、未知保存／native失敗後の同一要求Retry、二重click／shortcut、除外Undo優先・JPEG分岐・入力／IME／modal抑止、即時unmount・stale応答・切替／Windows close待機・200再生成を対象とした。
- 限定diff監査で、共通ViewModelとJPEG境界、SQLite由来metadataとcacheの責任、重複要求・gesture／retry順序、Preview・controls同期、ページ容量、世代／終了競合を確認した。受理直後unmountのqueue予約、保存後cache外の有効UUID保持とB2による対象消失拒否の区別、保存済み選択pageへの復帰、metadata取得と保存失敗の分離を補強して関連テストを再実行した。修正後もtypecheck／production build成功。未解決High／Mediumはない。

`git diff --check`成功。実LightCraft／GPU・Windows実機UI・ブラウザ動的確認は未実施。B3-1実機保存確認とB3-2の自動fake成功を混同しない。RAWカテゴリON/OFF・各Reset・Before/After・JPEGカテゴリ統合／個別ON/OFF削除・RAW Export／サムネイル・History手動整理／圧縮は変更していない。SQLite schema v8・200件保持・LightCraft固定version、README／CHANGELOGも維持する。

設計書・architectureを更新してCommit／Push後、C4-B3-2で停止する。B3-3統合検証とC4-C以降へは進まない。

## RAWスライダーのHistory commit後フォーカス（2026-10-23）

RAW sliderのHistory commitでは保存coordinatorが`raw.locked`をtrueにし、`RawAdjustmentControls`がrangeを一時的に`disabled`にする。Chromiumはdisabled化されたfocused rangeからDOM focusを外す。Shift＋カーソルでカテゴリから移動した場合はpointer hoverがないため、`onBlur`が`adjustmentFocus`の論理対象も解除していた。一方、マウス経由はhover中のblurを既存処理が無視するため論理対象が残り、保存解除後の連続キー入力に差が生じる。HistoryによるReact node再生成は原因ではなく、同じrange nodeがcommit中に登録されたまま、`raw.locked`とdisabledが遷移する。

キーボードナビゲーションが登録した対象について、save lockによるdisabled blurがdocument/bodyへ移った場合だけ、論理対象を一時保持する。lock解除後、同じ登録済み・接続済みrangeが有効で、かつdocument focusがbody/documentElementに残る時だけ`preventScroll`付きでfocusを復帰する。復帰前にfocusinで別要素へ移動するかwindowがblurした場合は復帰を破棄して論理対象も解除し、ユーザーが意図したfocusを奪わない。マウス経由、JPEGのsave/commit、raw saverのlock／Retry／History順序には変更を加えない。

RAW統合テストはShift navigation／mouse focusそれぞれでHistory commit前・lock中・ack後の`document.activeElement`、`keyboardAdjustment()`、登録状態、disabledを記録し、同じDOM node上で次の矢印入力が反映されることを確認する。さらにsave lock中に別のbuttonへfocusを移した場合、ack後もそのfocusを維持する。JPEGの既存controlsテストにもShiftでスライダーへ戻った後、通常の矢印入力・commitを連続できる回帰確認を加える。利用可能なWindows UIはインストーラー版でRAW非対応のため、現行ソースのRAW UIは実機手動確認していない。

## RAW調整コントロールの状態表示（2026-10-23）

Windows実機での操作時に、`raw.saving`・`raw.dirty`・`raw.pending`に対応する正常状態テキストがスライダー群の前へ挿入され、状態変化ごとに配置を押し下げていた。`RawAdjustmentControls`からsaving／dirty表示を削除し、pending表示は同じ状態を伝える`AnshitsuPage`のViewer status noteと合わせて描画しないようにした。CSSで非表示にはせず、文言を描画しない。

保存失敗、編集失敗、Session再生成失敗と各Retry操作は維持し、調整カテゴリ群の後ろへ配置した。Session再生成中の状態表示も末尾へ移したため、エラー／状態通知が現れても調整項目の位置は変化しない。`raw.locked`等の編集制限、History commit、Autosave、readback、Session再生成、JPEG状態表示には変更を加えていない。

`AnshitsuRawPreview.test.tsx`で保存中・保存後に正常状態文言が存在しないこと、native編集pending中もViewer status noteがなくスライダー要素が維持されること、保存失敗時に末尾のエラーとRetryが残り、入力がlockされることを確認する。FrontendのHistory／RAW保存関連テスト、TypeScript typecheck、production build、`git diff --check`を実行する。Windows実機での配置確認は依頼範囲のコード検証とは分け、未実施ならその旨を報告する。

## Phase 1C-C4-B3-3 統合検証・完了監査（2026-10-23）

開始HEAD `571526fe312ceec6a7f7de2fd56037d3b9ea01de`、`feature/lightcraft-integration`、作業ツリーclean。B1〜B3、直近の状態表示／フォーカス修正、C4 native機能調査、architecture、JPEG History／Recipe／shortcutを対象とした。既存のB1 transaction／B2障害注入／B3 gesture・UIテストは再実装せずに利用し、今回は両全スイートで改めて実行した。直前の181件や過去のfocused件数を今回の成功件数へ加算しない。

### 同じ履歴を追う統合検証と境界

`test_raw_history_api.py::test_history_lifecycle_restores_preview_cursor_across_switch_renewal_and_restart`を追加した。Windows LocalHost認証付きASGI HTTP→実Windows History API→実LightCraft manager／MCP adapter→実一時SQLiteを同じテストで通す。native child transportとRAW画像sourceだけを既存Fakeに置き換える。Previewは選択されたnative snapshotの露出値に応じた独立のPNG色markerを返し、応答bytes・token・revisionを確認する。実GPUの画質を検証したものではない。

RAW open→initialize→中間更新3回を含むgestureを3回commit→UUID／順序／cursorの再取得→Undo／Redo→baseline／任意UUID jump→no-op commitでもRedo保持→有効編集でのみ枝切り→過去stepへ戻る→別RAWを編集して元RAWへ復帰→同じRAWのSession解放・再生成→正常close→新LocalHost／manager／adapterから同じSQLiteを再open→Redo、まで連続確認した。各checkpointでSQLite current Recipe、選択snapshot、実adapter readbackの完全Settings一致、件数・UUID・cursor・revision、Preview markerを照合する。初期化／移動／再生成で架空stepを追加せず、native `edit.undo`／`edit.redo`／`history.restore`を使用しないことも全再生成childで確認した。正常close／再openは同じPythonテスト内の新ownerによる復元であり、OS process／WebViewの実終了・起動ではない。

FrontendのReact／coordinatorテストはAPI Fakeを使う別境界として扱う。実Frontendから上記ASGIを直接呼ぶブラウザE2Eは実施していない。既存テストと上記Backend統合テストを対応づけ、HTTP契約・保存順序・UI公開の各責任を確認した。

| 監査対象 | 確認した不変条件と主なテスト |
|---|---|
| gesture・保存順序 | `rawHistorySave`／`useRawDocument`で最終desired flush→同一ownership queue→native/readback確定→B2 commit→B1 transaction→ackを確認。中間native更新でstepを作らず、有効gestureだけが1stepとなる |
| current／cursor・冪等性 | History store／APIで選択snapshotとcurrentを同一transactionに保存し、saveId receiptとCASを検証。旧ackと最新currentを分離し、Frontendは最新cursor／revision／fingerprintとの一致後だけcleanにする |
| 不明結果・障害回復 | API／storeで応答喪失、同一body再送、SQLite実writer lock／SQLITE_FULL／commit失敗とrollback、native apply／readback不一致・desync、CAS外部writer、postcommit旧ownerを確認。失敗時はimmutable要求と入力lockを保持し、自動破棄／上書きしない |
| metadata GET | `rawHistorySave`でGET失敗と保存失敗を区別。保存成功を戻さず旧表示cacheを保持し、再取得はGETだけ。20件ページ、21件端数、最大200件、baseline／選択page再取得を確認 |
| 競合・ライフサイクル | gesture中Undo／Redo／jump、即時unmount、RAW↔RAW／JPEG、Filmstrip除外、通常終了待機、HTTP cancelを確認。generation／token／handle／assetが旧ownerの結果を新documentへ公開しない |
| 200 step／200・256 mutation | storeの200／201 stepでbaseline繰上げ・UUID保持・cursor整合を確認。APIの200到達再生成、hookの200でgesture hold→最終flush→保存成功後renewal、adapterの256到達後は新mutation未送信を確認。step数とmutation試行数を混同しない |
| RAW／JPEG・shortcut | History表示を分離しJPEG Recipe v18を維持。単一Undo／Redo dispatch、Filmstrip除外Undo優先、入力欄／IME／repeat／modal抑止を確認 |
| focus・状態表示 | Shift移動／静止pointer重なり／mouseのcommit前・lock中・ack後のDOM focus、論理対象、登録、disabled、同一DOM nodeを確認。別要素／別windowへの意図的移動では復帰しない。正常状態文言の非描画と末尾エラー／RetryのDOM構造を確認。実画面のpixel位置は未測定 |

### Findingと修正

| severity | Finding・影響 | 対応・結果 |
|---|---|---|
| High | 該当なし | 未解決なし |
| Medium | Shift移動で選んだrangeに静止pointerが重なると、`hovered`の早期returnが保存解除後のDOM focus復帰を飛ばす | 失敗する回帰テストで再現後、`AdjustmentSlider.onBlur`でキーボード所有権をhoverより先に評価した。`raw.locked`／disabled／Retry条件は変更しない。静止hover、mouse、別要素／window移動の回帰が成功 |
| Medium（テスト） | 既存v4／v5 migration fixtureがv8 Historyテーブルを残してuser_versionだけを下げ、再migration時にtable already existsとなる。Export既存データ保持の回帰検証を妨げる | 2つの旧schema fixtureから後発のHistory 3テーブルも取り除き、旧schemaを正確に構成。production schema／migrationは変更せず、一時DBのテストのみ修正。全Backend成功 |
| Low（テスト） | GalleryのRAW＋JPEG再開テストがRAW capabilityを提供せず、正しい非対応時filterを誤って失敗と判定する | fixtureで既定false／該当ケースtrueを明示。Galleryの製品動作は変更しない |
| Low（実行条件） | 全Frontendの高並列実行では重いGalleryテストが5秒timeoutになり、未完了処理が後続assertionへ影響した | 同じ3件の単独成功を確認後、`--maxWorkers=4`で全件成功。timeout／assertion／テスト件数を緩めず、既定configは変更しない。この環境の全suite監査では並列数4を使用する |

### 実行結果と完了判定

- Frontend全体：`npx vitest run --maxWorkers=4`、139ファイル、**3154 passed／2 skipped／0 failed**。skipは実WebGPU比較2件。最終実行でReact `act`警告は出ていない。
- Backend全体：repo `.venv` **Python 3.14.5**、cwd `backend`、`python -m pytest -q -rs`、**1768 passed／21 skipped／0 failed、326 subtests passed**。skipはWindows onedir配布artifact／native smoke buildが必要なケースであり、RAW HistoryのFakeテストskipではない。
- focused確認：Frontend UI／Gallery 121件と負荷切分け3件、Backend lifecycle／旧schema fixture 5件が成功。全suite後のlifecycle assertion補強は当該1件を再実行し成功。これらは全suiteと重複するので合算しない。
- TypeScript `tsc --noEmit`を含む`npm run build`、関連Backend 8ファイルの`py_compile`、`git diff --check`成功。production buildの既存500 kB超chunk警告は残るが失敗ではない。
- テストは既知のsandbox一時領域制限を避けて権限付き実行し、一時DB・Fake sourceだけを操作した。実profile／Immichデータへの書込・migration・デプロイは行っていない。

**C4-B3は実装・自動統合検証・全suite・限定監査の範囲で完了と判定する。未解決High／Mediumはない。** 以下の実機受入は今回未実施であり、自動成功をもって成功扱いしない。

- 現行開発ビルドのWindows WebViewで、mouse／Shift＋カーソルの連続操作、静止pointer重なり、保存lock解除時のfocus、別入力欄／別windowへの移動、正常状態更新時の実レイアウト位置、エラー／Retryを確認する。インストーラーの旧版で代替確認しない。
- 実LightCraft v0.10.0／実GPU／実RAWで、Undo／Redo／jumpの画像内容、復元の色・WB・その他完全Settings、連続gestureと200 mutation再生成を確認する。Fake Preview markerは実画質一致の証拠ではない。
- 実Immichに接続した写真切替・Filmstrip除外・通常Windows終了とprocess再起動、選択profileの実SQLiteからの復元を確認する。native bundle／process smokeの21 skipも別途artifactが必要。

LightCraftは引き続きv0.10.0（固定commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`）、SQLite schema v8、JPEG Recipe v18。v0.12.0更新・正常保存中disabledの再設計・History手動整理／圧縮・C4-CのカテゴリON/OFF／Reset・C4-D以降は実装しない。設計書とarchitectureを更新し、英語prefix＋日本語概要でCommit／Push後、C4-B3-3で停止する。
