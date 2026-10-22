# RAW現像統合 Phase 1C 実装前調査・設計

本書は**設計段階**の記録（2026-10-22、Asia/Tokyo）。Phase 1Cは未実装である。既存のRAW／JPEG暗室送信機能を再実装せず、その送信結果をWindows版のLightCraft RAW処理へ接続する。以下では「事実」を参照コードで確認した挙動、「提案」を今回の推奨構成、「未検証」を今後の確認対象として区別する。

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
| 既存設計 | [INTEGRATION_DESIGN](INTEGRATION_DESIGN.md)、[PHASE1A_DESIGN](PHASE1A_DESIGN.md)、[PHASE1B_DESIGN](PHASE1B_DESIGN.md)、[architecture](../../architecture.md)、[開発記録](../../development-notes.ja.md) |
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
| Filmstrip表示・移動・除外 | Adapterを介して共用 | 同じ集合とcallback。切替前flush、RAW一時編集badgeとavailabilityを接続 |
| Previewのpan／fit／zoom／全画面操作 | Adapterを介して共用 | ImageViewerに処理済みframe入力を追加。JPEG AdjustedImageを通さない |
| Preview pixel処理 | RAW専用 | LightCraft PNG。JPEG source decoder／renderAdjustments／WebGPUは呼ばない |
| Slider外観・数値入力・focus・begin/change/commit | Adapterを介して共用 | 基本項目の既存AdjustmentIdをUI識別子に使い、RAW controlへ明示対応。JPEG reducerは共用しない |
| WB | RAW専用の値表示・設定処理 | Kelvin／scale／AsShot。既存JPEG相対WBとは別binding |
| Before／After | Adapterを介して共用 | 同じ操作をRAW初期snapshot Previewと現在Previewへ接続。Immich PreviewをRAWのBeforeと偽らない |
| Reset | Adapterを介して共用 | RAW開始時の確定baselineへ全復元しreadback。JPEG allResetもSession再起動も別操作 |
| 編集状態表示 | Adapterを介して共用 | RAWは「このセッションの一時編集」。既存永続edited／historyOnly statusへ混入させない |
| ショートカット | Adapterを介して共用 | registry・formatterと各ownerのguardを維持。Undo／Reset等だけactive engineへdispatch |
| Recipe copy/paste・カテゴリbypass | Phase 1Cでは対応しない（RAW） | JPEG動作維持。RAWへのJPEG clipboard適用を禁止。RAWのbypass semanticsを推測しない。AdjustmentSliderのenabled／onToggleもJPEGのまま結線せず、RAWでは未対応のpower操作を隠す最小prop追加が必要 |
| History一覧 | Adapterを介して共用 | RAWの一時確定snapshot列を表示。JPEG History形式・永続保存とは分離 |
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

以下は新規実装案であり、現在のendpointではない。prefixはFrontendから`/api/raw`、原本path、PhotoId、任意commandを受け付けない。JSONは型・件数・byte上限を検証する。

| API案 | 入出力・責務 |
|---|---|
| `GET /capabilities` | available／state／version／制限情報の安全なsubset。起動やGPU照会をGETの副作用にしない。Dockerで404ならunsupported |
| `POST /documents` | Asset ID＋workspace ID（初回はBackend発行）→document handle、generation、revision、確定settings、baseline識別子。UUID検証、Asset detailをBackend再確認 |
| `GET /documents/{handle}` | workspaceの確定snapshot／revision／状態を取得。選択変更やimportは行わず、response消失後の再同期にも使用 |
| `POST /documents/{handle}/select` | 保持documentをactiveにし、session選択epochと現在snapshotを返す。再importなら新tokenを返す |
| `PATCH /documents/{handle}/controls` | expectedRevision、client mutation ID、許可control値→readback＋revision。任意DevelopSettings mergeは公開しない |
| `POST /documents/{handle}/preview` | expectedRevision、client selection serial／request serial、maxSide→PNG bytes＋一致確認用response headers。Supersededは204、画像なし |
| `POST /documents/{handle}/restore` | baselineまたはBackend発行snapshot ID＋expectedRevision→確定snapshot。Reset／Undo／Redoで利用、任意path／任意設定を拒否 |
| `POST /session/reset` | workspace ID＋expectedGeneration、明示復旧／安全な世代再生成。新handle対応表を返す |
| `DELETE /workspaces/{id}` | 明示破棄／終了。要求を無効化し、Engineから参照がなくなってからowned RAW fileを回収。JPEG処理を停止しない |

認証は既存LocalHostのHost／Origin／per-start cookie／bootstrap方式の内側で行う。同一origin fetch、no-store、画像responseも認証必須。CSRF対策を緩めない。opaque IDは認証の代替ではなく、現在のworkspace所有権も照合する。複数画面からの競合は初期版では単一RAW workspace ownerと409で扱い、黙って選択を奪わない。既存cookie名等の秘密はAPIやログに返さない。

エラーは固定codeへmapし、revision／handle不一致は409、上限到達は明示したcapacity code、サイズ超過は413、engine unavailableは503を候補とする。HTTP statusだけで診断severityを決めない。pathやupstream本文を返さない。更新requestのresponse消失時は同じ変更を無条件再送しない。mutation IDの重複結果照会または現在snapshot取得による再同期を設ける。

### 7.2 原本の取得と所有

**事実：** `get_asset_original`と既存original endpointはJPEG限定でContent-TypeもJPEG検証する。FrontendからダウンロードしたBlobをfile pathとしてLightCraftへ渡す経路はない。

**提案：** Windows専用source providerがAsset IDからImmich detailを確認し、Backendの資格情報で原本をstream取得し、私有ローカルcacheへ保存する。既存Immich HTTP設定／例外・redaction方針を再利用するが、JPEG用関数の制限を緩めずRAW専用取得関数を追加する。RAW種別はdetail＋LightCraft inspectで再検証し、preview_onlyを編集可能としない。

cacheはFrontend指定path／URLを受理せずBackend発行名、固定local drive、拡張子allowlist、容量／timeout制限、途中fileと完成fileの分離、stream closeと失敗cleanupを持つ。原本の最大bytes・cache総量・空きdisk閾値はC1で定数とテストを確定し、無制限downloadは禁止。大きいRAWのstream hash計算と移動もevent loop外・期限付きとする。初期版は同時download 1件、activeだけの遅延取得を推奨。Immichの実保存pathを推測・共有driveで直接開く方式を前提にしない。

Backendが`workspace ID + Asset ID`とsource_keyを対応させ、cache path／fingerprint／content hash／LightCraft PhotoIdを内部管理する。退避後の再downloadではfile fingerprintが変わり得るため、Asset IDだけで旧設定を適用せずcontent hashで同一原本を確認し、新しいlocal fingerprintへ安全に再bindする。現行restore_settingsは同じsourceとfingerprintを要求するので、検証済み退避snapshot専用の内部rehydrate拡張が必要である。

### 7.3 PNGとBlob URL

Phase 1Bの検証済み`PreviewFrame.data`を`image/png` binary responseにする。Base64 JSONをFrontendへ再配信せず、file URL／data URL／公開画像directory／永続Preview cacheは追加しない。初期版はPOST responseで直接返し、期限付きPreview IDの別GET・cacheは必要になってから追加する。

response headersにgeneration／document token／revision／selection epoch／sequenceとclient要求識別子を含め、Frontendはblob読取り前とdecode後の両方で照合する。PNGには5 MiB等の既存上限を適用し、HTTP層でもContent-Type／受信bytesを検査する。`URL.createObjectURL`は受理候補だけに実行。新画像decodeと所有確認後に表示をswapし旧URLをrevokeする。拒否、decode失敗、写真切替、離脱、unmountでは候補と表示URLを両方解放する。decoded bitmapを使う場合はcloseも必要。

### 7.4 更新順序とstale防止

| 共有状態 | 所有者・更新条件・不変条件（追加案） |
|---|---|
| workspace／Asset document対応 | Backend RAW workspace。Asset IDから原本identityを確認して登録。frontend handleは現在generationだけ有効 |
| desired values／client edit serial | RAW hook。入力ごとに更新、受信readbackで未送信の新入力を上書きしない |
| confirmed settings／revision | Phase 1B＋workspace snapshot store。成功readbackのみ更新。UI値・履歴の確定根拠 |
| selection serial | Frontend暗室owner。切替開始時に同期的に増加し、A→B→Aでも旧A結果を拒否 |
| selection epoch／sequence | 既存Backend RAW service。Frontendのserialとは別。ticket guardを維持 |
| frame／Blob URL | RAW表示hook。全identityが一致したframeのみ表示。旧document frameをloading中に残さない |
| baseline／確定履歴cursor | RAW workspace。原本identity／engine versionと共に保持。native Session再生成で失わない |

1. Slider changeは即座にdesiredを更新。初期debounce案は100 ms（性能保証値ではない）。Preview debounceと既存Sliderの500 ms commit境界は別にする。commit時はtimerを待たず最後のdesiredをflushする。
2. Frontendの設定送信は実行中1件＋最新desired mapだけ。既存Backendはmutationsを自動集約しないので、各inputを並列PATCHしない。複数control変更は最新値を一つの許可mapにまとめる。
3. PATCHは最新confirmed revisionで送信し、readbackでその要求に対応する確定値だけ更新。送信中に増えたdesired serialは保持して次に送る。補正値を反映するのは、該当controlにそれ以降の入力がない場合。失敗はconfirmedを進めずdirty／未適用を表示する。
4. Preview要求は確定revisionにだけ送信する。Frontendも最大実行中1件＋最新必要revisionだけを保持。設定更新中の古い画像を「最新」としない。Backendの既存1＋1集約とticket guardはそのまま使う。
5. 表示直前にworkspace、Asset ID、Frontend selection serial／desired serial、generation、document token、confirmed revision、request serial、Backend epoch／sequenceを確認する。新desiredがある場合は旧revisionの結果で画面を巻き戻さない。React effect cleanupだけに依存せずrender時にもidentityで隠す。
6. 写真切替は新操作を止め、最後の変更のreadbackを待ちsnapshot／一時Historyを確定してから既存navigateへ進む。失敗なら切替を止め、再同期／明示破棄を提示。切替開始時に旧Preview待機をabandonし、未完了response／decodeはserial不一致で破棄する。
7. AbortControllerはHTTP待機の停止であり、送信済みMCP操作をcancelした保証ではない。HTTP切断で内部mutationを不用意にcancelするとPhase 1Bの接続無効化を招く。workspaceがbounded taskを所有し、送信済み操作は完了・readbackまで管理する。Preview待機cancelは既存ticket.abandonedを使い、実処理はworker所有のままにする。
8. 離脱時はtimer停止、serial無効化、HTTP waiter abort、URL解放。workspaceの処理をdrainし、明示release後にfileを回収する。pagehideの非同期DELETE到達を保証とせず、Backend終了／owner失効時の期限付き回収を設ける。LightCraft未回収中に原本cacheを削除しない。

### 7.5 異常終了と診断

lost／desynchronized／resettingをRAW panelへ表示し、設定操作・Undoを止める。JPEG写真は引き続き使える。LightCraft復旧は明示ボタンで行い、最後の確定snapshotを新generationへ復元する。未確定desiredは保持・未適用表示し、自動再送せず復旧後の適用／破棄を選べるようにする。cleanup失敗ではrestart不可の既存保証を維持する。Reset（編集初期化）と復旧（Engine再起動）は別labelにする。

診断は既存frontendLogger／backend loggerを使用し、open、設定適用の失敗、世代更新、stale、容量再生成、回収・復旧の境界を選ぶ。成功の詳細・revision／sequence／timingはdebug、重要な開始／完了はinfo、復旧可能異常はwarn、必要操作の最終失敗はerror。Asset ID、世代、revision、counts／bytes、固定codeだけを採用し、path、設定本文、画像、URL、秘密、任意エラー本文を記録しない。logging失敗は操作へ影響させない。

## 8. RAW SessionとFilmstrip管理（提案）

**必要な変更：** Filmstripの枚数とLightCraft resident枚数を切り離す。全写真を起動時にimportしない。RAW workspaceの軽量snapshotとEngine resident/cacheの寿命を分け、JPEG documentにはRAW handleを作らない。

最小で実用化する初期方針は、**確定snapshot退避＋bounded generation再生成**。上限だけを引き上げる案は推奨しない。

- C1のPreview接続では既存2枚／256回を一時的に維持してよいが、その段階をPhase 1C全体の完了としない。
- C3でworkspaceに全訪問RAWの確定snapshot／baseline／履歴を退避する。現行`_photos`の2枚上限から独立した、byte数と履歴件数を制限するstoreを追加する。上限到達時は新規編集・importを明示拒否し、dirty snapshotをLRUで黙って捨てない。
- 3枚目へ進む際は旧activeのflush・退避後にEngineを再生成し、旧generationの全resident参照を解放する。新activeを遅延importしてsnapshotを全復元・readback照合する。元の全document handleを無効化する。snapshot storeを退避せず`reset_session(False)`を呼ぶだけでは編集が消えるので不可。
- 原本cacheはactiveと必要な少数residentに限定し、Engine回収後に未使用fileを削除。復帰は再download＋content照合。再download不要の小規模LRU cacheは後続改善でよい。
- 256回到達前の安全な境界で同じ再生成を行う。例として200試行をsoft threshold候補とし、操作途中ではなくreadback／commit完了後に実施する。hard limit到達時も最新の確定snapshotを保持し、次操作を待機させる。数値はC3のfocused負荷試験で確定する。
- 再生成中の新desiredは単一mapに保持し、復元完了後の新revisionを基に適用する。復元不一致・原本変更・再import失敗時はsnapshotを残して停止し、defaultで編集継続した成功扱いにしない。
- JPEG→RAW／RAW→JPEGでも同じFilmstrip順序とGallery復帰を維持する。JPEGの保存failure guardとRAWのflush failure guardの双方を尊重する。RAW→JPEGでEngineを直ちに再起動する必要はないが、idle releaseと再入時復元はworkspaceが管理する。

nativeの個別evictionやinteraction／history整理を公開する案は改善候補。現行RAW allowlist/interfaceには解放・interaction APIがない。`history.clear`は新たなcommitを作るので、それだけで全Undo memoryや試行制限を解消したとみなせない。後続でLightCraft cache／catalog／Undoまで実際に解放されることを調査してから採用する。専用Rust Adapter／StageCacheへの移行はPhase 1C必須にしない。

**未検証：** 再生成の実用待ち時間、再download費用、長時間native memory、store上限値、download上限、idle期限。PoCの短時間測定を長時間保証へ拡張しない。Phase 1C受入には3枚以上と256試行を超える編集の継続確認が必要である。

## 9. Recipe／History／Exportとの境界

### 9.1 Recipe・写真切替・Session reset

**事実：** JPEGはRecipe v18、`useAssetEdits`のAsset別record、`editState.ts`のvalidation／migration、Backend保存revision／save ID、autosave・retry／conflictを持つ。LightCraftはDevelopSettingsのschema `version`と描画`process`が別で、さらにengine version／commitがある。

**提案：** Phase 1CはRAWを**一時編集**として扱い、JPEG DB schema／Recipe versionを変更しない。RAW workspaceはAsset ID＋原本content identity＋engine=`lightcraft`＋`0.10.0`＋固定commit＋settings schema version＋process＋WB scaleを含む完全snapshotを管理する。Frontendへ出す設定はUI用、復元の正本はBackend。UI未対応fieldもsnapshot全体に保持する。

同じBackend session中のGallery復帰・暗室再開では既存navigation集合と別にworkspace IDを保持し、RAW一時設定を再取得できるようにする。workspaceはAnshitsu unmountだけで破棄せず、idle期限／明示破棄／アプリ終了で解放する。期限と一時保存の表示を明示し、復帰時にworkspaceが消えていれば初期状態になったことを知らせる。close／refreshではRAW未永続化の編集が失われる旨を既存desktop close guardへ接続し、JPEGの保存確認を妨げない。

後続永続化ではengine別envelope／validator／revision／idempotent saveを設計する。RAWをJPEG EditStateSnapshotへcastせず、JPEG保存エラー／競合保証を緩めない。Engine更新とprocess更新は別操作。XMP自動書込みやJPEG Recipeからの推測変換はしない。永続化未対応を「保存済み」と表示しない。

### 9.2 History／Undo／Redo

**事実：** JPEGは`begin/change/commit`でbefore／after Recipeを一履歴にまとめ、cursorとpendingを管理する。Sliderのpointer・wheel・keyboard・numberの確定境界を持つ。LightCraftにはnative History／Session Undoと`develop.beginInteraction/endInteraction/cancelInteraction`があるが、Phase 1Bは公開せず、各変更がnative履歴を増やし得る。

**提案：** Phase 1CではGenzoRoom RAW workspaceがreadback済みのbefore／after完全snapshotとcursorを一時管理する。既存SliderのonBegin／onCommitを使い、途中Previewの変更回数をUI History件数にしない。commit後に最終readbackを待って1件を確定し、値不変なら追加しない。失敗／lostでは未確定操作を確定履歴へ入れない。

Undo／RedoはRAW snapshot IDのrestore→readback成功後にcursorを更新し、新変更でredo枝を切る。切替時はpendingをflushして確定し、再生成後も一時Historyから復元する。native History cursorやSession全体UndoをJPEG shortcutへ直結しない。Undo自体も現行mutation試行を消費するため容量再生成の対象に含める。RAW History clear／trim、clipboard、永続Historyは後続。初期C1／C2で未対応のUndoは明示無効、C4で操作体系を完成する。

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
| C3: Filmstrip・容量 | 新`backend/raw_workspace.py`、`lightcraft_raw.py`の安全なsnapshot退避／rehydrate、source cache、`useRawDocument.ts`／暗室切替・復帰、`workspaceResume.ts`／`assets.ts`のworkspace識別子接続 | 既存navigate／Gallery resumeを使う。JPEG保存guardを保持。3枚以上・長時間制限を実用化 | 3枚以上A→B→C→A、RAW/JPEG混在、256超試行、世代途中失敗、再download identity変更、store／disk上限、cancel／cleanup | 3枚以上巡回・多数変更で設定保持、原本変更は停止、容量拒否で既存編集を失わない。実測でcache／memory・待ち時間を評価。前提: C2 |
| C4: 操作整合 | RAW一時History／baseline Before／Reset、`EditHistory.tsx`のview adapter、`ImageViewer.tsx`、`AnshitsuPage.tsx`、desktop close guard、既存shortcut registry／翻訳の必要箇所 | JPEG Undo／保存／Queueを維持。RAWの一時編集表示・終了確認。Beforeは同engineのbaseline | gesture単位、Undo／Redo／枝切りと復元失敗、Before frame identity、zoom維持、キーguard、切替失敗、close／復帰、RAW Queue不可 | JPEG/RAW混在でUndo・Resetがactiveだけに作用、Gallery復帰で一時設定保持、終了時に未永続化を説明。前提: C3 |
| C5: 完了確認 | 変更diffと影響境界レビュー、focused回帰、必要な設計文書追随 | Windows RAW追加とDocker JPEG維持の確認 | 関連Frontend unit／integration、TS check／production build、関連Backend（repo Python3.14・cwd backend）、git diff --check。全suiteはfocusedで不足する理由がある場合のみ | ユーザーによるWindows/Tauri・WebView2実画面、長時間・終了・復旧、既存Docker JPEG/NAS/Firefox確認。実施していない項目は未検証として明示。前提: C1–C4 |

C1だけで「RAWを編集できるPhase 1C完了」としない。C2–C4の設定・切替・容量・一時編集保護を含むことが推奨完了範囲。RAW永続保存、最終Export、高解像度Preview、エンジン統合、LightCraft更新、専用Rust Adapterは後続へ残す。

## 11. テストと受入条件

本調査ではコード／テストを変更せず、自動テスト・build・実機確認は行わない。文書差分と`git diff --check`を今回の検証とする。以下は実装時の計画である。

- 送信回帰：`galleryAssetSelection`／`workspaceAssetResolver`／`GalleryStacks`で手動RAW・両方・非RAW、単独、RAW-only fallback、Export素材除外、全OFF、不完全snapshot、member複数、順序・重複、再開時に再展開しないことを保持する。
- API境界：LocalHost認証／Origin／Host、Docker route不在、偽handle・別workspace・旧generation、request body上限、原本stream失敗・cancel・サイズ超過、JSONへのpath混入なし、原本／sidecarを変更しないこと。
- 非同期：fake clock／gateでdesired変更、PATCH response消失、readback補正、A→B→A、decode中切替、離脱、reopen、reset、worker失敗を再現。送信中最大1、待機最新のみ、古い画像ゼロ、URLとtask解放を検証する。HTTP abortとMCP中断を混同しない。
- Session：3枚以上、256超試行、generation再生成、非active snapshot／History復元、content不一致、cleanup失敗でrestart禁止、store容量拒否時の保護。native memoryの完全解放はfakeテストだけで保証しない。
- 編集：Slider gesture・数値入力・keyboardの確定単位、Undo／Redo復元失敗時cursor維持、Resetのbaseline、Before中も設定不変、JPEG clipboard拒否、RAWのScope／Queue無効化、JPEG autosave／conflict／Queueの回帰。
- 実機：Windowsの既存送信操作から同一暗室にRAW Preview、代表RAWでWB／基本補正、混在写真切替とGallery復帰、zoom保持、1024制限表示、Engine終了から明示復旧、長時間操作・正常終了のprocess／TEMP回収。色管理はWebView2でsRGB／orientationを確認し、JPEGとの同値画質を合格条件にしない。
- Docker正式版：RAW capabilityがなくてもJPEG編集・保存・Queue／Exportに変更がないことを関連自動回帰で確認する。フルDocker release Smoke Testは通常開発では行わない。runtime依存／storage／startupを変える実装になった場合は`release/smoke-test.sh`への影響を再評価する。

実機・NAS／Firefox検証はユーザーの実施領域であり、今回実施済みとは報告しない。実装時もブラウザ動的確認は明示指示がある場合に限る。

## 12. 未決定事項・後続Phaseへの引継ぎ

| 判断時期 | 未決定／未検証 | 推奨判断基準 |
|---|---|---|
| C1前 | 原本bytes／disk budget／download期限・安全な拡張子、HTTP header名称／エラーschema | 無制限を許さず、代表的RAWを拒否しすぎない値と境界テストを実装時に確定 |
| C2 WB前 | matrixなしRAWの能力判定、AsShot／Customの正確な遷移、K track | 固定v0.10.0のinspect／WB commandを追加確認。判定不能ならWBだけ無効化 |
| C3前 | snapshot／History store上限、soft再生成閾値、idle TTL、同時画面所有 | 最新確定編集を黙って失わず、容量拒否・再開失効を明示できること |
| C3受入 | 世代再生成の待ち時間／cache削除／再download、長時間memory | 実測を根拠に少数resident数やcacheを調整。PoC上限を製品仕様へ転記しない |
| C4受入 | 一時編集のclose／refresh表示、Before baselineの再取得、WebView2色管理 | 永続保存と誤認させず、旧frame表示や二重現像を防ぐ |
| 後続 | RAW永続Recipe／History、schema・migration、engine更新・process保持 | JPEG形式と分離し、保存失敗／retry／conflictを設計してから実装 |
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

`backend/raw_controls.py`は固定v0.10.0の`crates/develop/src/controls.rs`の上記specだけをallowlist化する。`RawAdjustmentControls.tsx`は既存右パネルと`AdjustmentSlider`のrange・数値入力・keyboard／wheel・確定方法を使用する。共通Sliderへ追加した`actions=false`はRAWでbypass／resetだけを省き、JPEG既定動作を変更しない。UI focus用AdjustmentIdは再利用するが、値のbindingはnative control IDに分離し、JPEG reducer／Recipe・clipboardへ渡さない。WB・基本・色の3カテゴリのみを表示し、RAW Color Gradingは追加しない。

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
