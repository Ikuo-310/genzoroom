# フィルムストリップ切替とNative Sessionの寿命

基準はGenzoRoom main `b5296dd0fdde7f82f1623fa168585c167b44b102`。P1-1〜P1-3は実装済み。2026-11-21のWindows Desktop実測と、P2のResident管理に関するソース調査・設計案を記録する。

## 目的と計測

現像作業中のフィルムストリップ画像切替、特に訪問済み写真への往復を高速化する。Immichからの初回原本取得と初回Native Importの高速化は主目的ではない。

P0・P1事前調査では、画像切替に伴うNativeプロセス再生成と、同一Sessionの初回Previewと2回目Previewの時間差を調査対象とした。今回参照できる記録には、それぞれのログの計測値・測定条件・対象画像が残っていないため、数値や改善幅は確定できない。元ログの所在と値の対応付けは未解決である。別条件の過去記録には初回RAW open約2秒、初回Region Plan約660ms、同一Documentの再Plan約0.25msがあるが、これらを今回のフィルムストリップ切替のPreview計測値として扱わない。詳細は [LightCraft更新ガイド](UPDATE_GUIDE.md) と [Region Plan計測](REGION_C3B_PLAN_TIMING.md) を参照する。

## 現行ライフサイクル

BackendのWorkspaceは単一の公開Documentと、そのWorkspace専用のRawSourceCacheを所有する。LightCraftRawSessionはNativeプロセスのgenerationに紐づく写真snapshotとResidentのPhotoIdを管理する。RawSourceCacheの完成コピーはNativeが参照する期間を通じて保持する。

通常の写真切替ではFrontendが入力を停止し、Native readbackとRecipe／Historyの保存を確定してから移動する。P1以前はAsset単位のcleanupがWorkspaceも解放していた。現在は `useRawDocument` の暗室単位ownerがWorkspaceを保持し、`DELETE /documents/{handle}` が保存チェックポイントと画像処理・送信の排出を経て旧Documentだけを閉じる。同じWorkspaceで次のAssetを開ける。Workspace全体の `DELETE /workspaces/{id}` は引き続きSessionと原本コピーを回収する。

Preview／RegionはNative処理後にBackendのownerやrevisionを再確認する。送信済み操作はHTTP待機側の取消だけでは終了せず、画像応答のleaseはASGI送信完了まで所有される。保存未確定の場合は旧ownerを保持し、確認できない状態を保存成功として扱わない。明示Discardと通常Releaseは別の終了経路を持つ。

## P1-1の完了記録

Commit `3edfc505` でRawSourceCacheは同一Workspace内のAssetごとの完成コピーを保持し、パスとファイル情報のfingerprintを照合して再利用する。コピーはWorkspaceの回収まで保持する。Native側は写真ごとのImport直後の既定設定を保持し、Residentを再選択した際にも既定値のfingerprintを編集後の値で置き換えない。

Document OpenはSQLiteのRecipeとHistoryのidentity・revisionを照合し、保存済みRecipeを復元する。Recipeがない場合とエンジン非互換の回復経路では、必要に応じてImport既定設定へ戻す。Native Session内のA→B→AではAを再Importせず、tokenを更新する。原本コピーが変化した場合や復元に失敗した場合はDocumentを公開しない。P1-1完了時のBackend focused testsは250件成功した。

## P1-2の設計

以下はP1-2で採用した契約。Close本体は `RawPreviewApi._close_document_owned()` が所有する。

### HTTP契約と所有権

`DELETE /documents/{handle}` は本文を持たず、`X-Raw-Workspace`、`X-Raw-Generation`、`X-Raw-Token`、`X-Raw-Revision` を必須とする。generationとrevisionは非負の10進整数、handleとtokenは発行済みの不透明な値とする。Workspace、handle、generation、token、revisionの組をCloseの識別情報とし、ownerと現在のrevisionを照合する。不正な形式は400、owner・generation・tokenの不一致は409 `raw_stale_handle`、revision不一致は409 `raw_revision_conflict` とする。Workspace所有者でない要求は既存の `raw_workspace_conflict` とする。認証・コマンド認可は既存の境界を通す。

成功は本文なしの204と `Cache-Control: no-store` を返す。成功後もWorkspace ID、Native generation、Resident、原本コピー、Workspace leaseは継続し、公開Documentは空になる。完了前は次DocumentのOpenを409 `raw_busy` で拒否する。完了後は既存の `POST /documents` によって同じWorkspaceでOpenできる。OpenはP1-1の `RawSourceCache.download()`、`LightCraftRawSession.open_raw()`、`_restore_document()` を使い、新しい公開handleとdocument tokenを発行する。旧handleの操作は `_document()` で拒否し、旧Preview／Region／Beforeの結果は旧ownerにしか属さない。

Closeの成功receiptはWorkspace内に直近1件の識別情報だけ保持する。次のDocumentが開かれていても、完全一致する旧Closeの再送にはそのreceiptに基づき204を返し、現Documentを参照・変更しない。次のClose成功時またはWorkspace終了時にreceiptを破棄する。それより古い再送や識別情報が異なる要求は409とし、現Documentには作用しない。新たな汎用トランザクションや永続receiptは設けない。Workspace終了後の再送は `raw_workspace_conflict` とする。

### 受付、チェックポイント、終了待ち

状態は `active(document)` → `closing(document)` → `active(no document)` とする。失敗して保存状況が未確定の場合は `active(document)` に戻し、旧Documentと保存ownerを保持する。Native Sessionが失われた場合は旧Documentを再利用可能と扱わず、既存のSession喪失・Discard／Workspace回収経路に渡す。

1. `endpoint()` のClose専用受付でWorkspaceと識別情報を確認する。event loop上でawaitする前に閉鎖対象を固定し、新規のDocument操作とOpenの受付を止める。同一識別情報の並行Closeは同じshieldされたClose taskに合流する。異なるClose、Workspace Release、edit resetと新しい画像・編集・保存操作は409 `raw_busy` を返す。新規DiscardはClose終了を待ってから処理し、既存の明示Discardの意味を維持する。状態確認や認証不要の公開情報は既存の範囲で利用できる。
2. 受付停止前に既に受理した操作を、Close自身を除く既存 `_tasks` と `_history_tasks` の所有taskで待つ。中断したHTTP waiterに代わり、`endpoint()` が使う `asyncio.shield` と同じくtaskが完了まで所有する。新たなNative interactionは開始せず、受付済みinteractionの終了を待つ。未終了のcurve／mixer／point-color interaction、geometry gesture、保存結果不明はチェックポイントで拒否する。受付済み操作の結果、revisionが指定値から変化した場合もCloseを拒否する。
3. `_lock` 内でownerとrevisionを再照合し、`_history_checkpoint()`／`_history_checkpoint_reserved()` と既存のRecipe保存・Native同期検査を使って保存確定を確認する。初期History未作成やエンジン非互換回復では、保存済みRecipeの有無とImport既定状態を確認し、未保存編集や未確定保存を通さない。checkpoint失敗時はClosingを解除し、旧DocumentのRetry／Discardを可能にする。
4. checkpoint成功後は旧ownerを採用不可にする。未送信ticketを既存の無効化で終結させ、受付済み `_image_tasks` が終了するのを `_lock` の外で待つ。`_preview()`、`_region()` とinteraction previewはNative完了後に同じlockを再取得するため、待機中にlockを保持しない。Closing後にまだ生成中だった結果は旧ownerの失効判定で204 supersededまたは既存エラーとし、PNGを新たに送らない。
5. 既に返却済みの `_ImageResponse` は `_hold_image_response()` と `_images_idle` でASGI送信完了・切断・timeoutまで待つ。`_images_idle` はresponse leaseだけを追跡するため、実行中の `_image_tasks` の待機を省略しない。いずれもlock外で待つ。既に送信が始まった応答は途中で取り消せないため、旧token／revisionを持つ応答として完了させ、次Documentの公開前にleaseを解放する。
6. `_lock` を再取得して同一Workspace・旧Document・Closing task・generationを再確認し、Document、`_raw_handle`、Preview serial、Region／WB、Recipe／History／gestureのDocument所有状態を破棄する。成功receiptを記録して空Document状態を公開し、204を返す。Native写真、CacheとWorkspace leaseは保持する。

Close中はownerの外部受付を閉じるが、既に受理されたtaskの内部 `_document()`／`_history_verify()` 再確認は完了できるよう区別する。全呼出しを一律にClosingで拒否すると保存確認や画像処理が完了できない。新規受付側で遮断し、checkpoint成功後の応答採用判定でClosingを確認する。Native喪失、checkpoint失敗、待機失敗、shutdownは成功receiptを作らない。Close ownerが終結するまでWorkspace leaseの自動解放を保留し、Close完了・失敗時にleaseを更新する。shutdownは既存 `close()` がClose ownerの完了を待ってからSessionとCacheを回収する。

### 応答喪失と再試行

| 状態 | 契約 |
| --- | --- |
| Close受付前に失敗 | 旧Documentが有効。保存・owner・revisionを確認し、同じ識別情報で再送できる。 |
| Close実行中にHTTP切断 | shieldされた同一Close taskが処理を継続する。同じ識別情報の再送はそのtaskに合流し、成功または失敗を受け取る。 |
| Close成功後に応答だけ喪失 | 直近receiptと完全一致する再送は、空Workspaceでも次DocumentのOpen後でも204を返す。 |
| Close成功後に次Openが失敗 | Close済みの旧Documentは復活しない。現行Openの失敗処理は `_release()` によりWorkspaceも回収し得る。P1-2ではこの既存契約を維持し、クライアントはWorkspaceの終了を確認して新Workspaceを作り、保存済みRecipeからOpenを再試行する。 |
| 遅延した旧Close | receipt一致なら204、それ以外は409。いずれも現Documentを終了しない。 |

保存が未確定なら旧Documentを保持し、既存Retryまたは明示Discardを使う。Close成功後のOpen応答喪失は、現行のWorkspace状態確認と安全なRelease／再Openで回復する。Openの冪等化や新たな公開状態照会APIはP1-3以降の課題とする。

### 実装順と受入条件

1. **Close ownerとcheckpoint**。対象は `endpoint()`、`_document()`、`_history_checkpoint()` とDocument所有状態。旧ownerの完全一致、受付停止、受理済み操作の完了、未保存・revision競合時の旧Document保持を実装する。最小回帰は保存未確定、同時mutation、interaction、同一／異なるClose重複。
2. **画像処理の排出と失効**。対象は `_preview()`、`_region()`、interaction preview、`_image_tasks`、`_images_idle` とClose task。lock外でtask・送信leaseを待ち、旧結果を抑止してから空Documentを公開する。最小回帰は進行中Preview／Region、ASGI送信停止・切断、遅延応答、Open競合、Native障害。
3. **再送とWorkspaceとの統合**。対象はClose receipt、`_execute()` のDocument Open／Workspace Release、`_discard()`、`_expire()`、`close()`。Close応答喪失の再送が新Documentへ作用しないこと、Discard・lease・shutdownがClose ownerと直列化されること、Releaseが従来どおり回収することを確認する。最小回帰はClose中切断、成功後再送、新Document後の旧再送、Open失敗、Discard／Release／期限との競合。
4. **Residentと予算の統合確認**。同一WorkspaceでA→B→Aを行い、Workspace IDとNative generationを維持し、Aを再Importせず保存済みRecipe／History cursorを復元する。3枚目の容量拒否、200／256試行到達後には既存の保存確定・Workspace Release／再生成経路で続行できることをfocused testsで確認する。

P1ではResident最大2枚、変更試行の再生成閾値200・上限256を維持する。上限やNative障害に達した場合は、保存確定と旧プロセスの回収を前提に既存の安全な再生成経路を使う。新たな写真退役APIはP1に含めない。

## P1-3 Frontend実装設計

P1-3の設計基準はmain `7bb85c81c0b3fd8c496977f2341e428fa98848af`。Frontend接続・表示失効・異常回復の実装は `b5296dd` までに完了した。

### 現行の所有関係

`App.tsx` の `/anshitsu/:assetId` は同じ `AnshitsuPage` を描画する。`AnshitsuPage` は詳細情報が現在のAssetに一致し、現像方針がLightCraftのとき `useRawDocument(assetId)` を有効にする。Workspace IDはHookの `workspaceOwnerRef` が保持する。`[assetId]` effectがDocument、`RawControls`、`RawRecipeSave`、Preview／Region、heartbeatを所有する。新effectのOpenはmodule内の `ownership` queueと `pointColorTermination` を待つ。

`activateAsset()`、`excludeAsset()`、`exitToHome()`、`useDesktopCloseGuard` は `prepareSave()` を通す。`prepareSave()` は入力と表示を停止し、interaction、Controlsのreadback、HistoryとRecipeの保存が確定するまで待つ。`RawWorkspaceTermination` は保存・解放の段階を保持し、応答不明時の再試行を所有する。これらは継続して利用する。

### 所有者と状態遷移

Workspaceは暗室滞在中に生存する `AnshitsuPage` 内の `useRawDocument` のWorkspace単位ownerが所有する。同じHook内のWorkspace用effect／refと既存 `ownership` queueを使い、別のProviderや汎用dispatcherは追加しない。Workspaceの生成はLightCraftを使う最初のDocument Open時に遅延する。Asset単位effectはDocument、Controls、Saver、画像表示だけを所有し、`activeDetail` の待機やAsset変更でWorkspaceを解放しない。ページのunmount・pagehideはWorkspace ownerの終了境界とする。画面が再マウントされる場合は旧ownerの終了・回収を既存queueとtermination ownerで待ち、同時に2つのownerを作らない。

状態は `未作成 → Workspace準備済み／Documentなし → Open中 → 編集中 → 保存確定中 → Close中 → Documentなし` とする。暗室終了は保存確定後に `Workspace解放中 → 終了` へ進む。再生成は `保存確定中 → Workspace解放中 → 新Workspace作成 → Open中 → 編集中` とする。各状態の処理は既存queueで直列化し、Workspace、Document、移行要求の所有権は互いに独立した並列queueを作らない。

通常切替は次の順序とする。

1. `activateAsset()` またはactive写真を対象とする `excludeAsset()` が現在の切替ガードを取得し、`prepareSave()` を完了させる。保存失敗・History結果不明・gesture未確定・再生成中は旧DocumentとSaverを保持して切替を止める。
2. 保存確定後の `RawControls.confirmed` から `workspaceId`、`handle`、`generation`、`documentToken`、`revision` を一度だけ固定する。保存前のDocumentや描画応答のrevisionをCloseに使わない。旧Documentをfreezeし、Preview／Region／Beforeの発行と表示採用を停止する。
3. `rawApi.ts` にDocument Closeを追加し、`DELETE /documents/{handle}` へ `X-Raw-Workspace`、`X-Raw-Generation`、`X-Raw-Token`、`X-Raw-Revision` を送る。これらの値と送信済み結果不明のClose ownerを旧Saverとともに保持し、再送時も同じ識別情報を使う。成功receiptがBackendにある間の重複Closeは同じ結果を返す。
4. Close成功後に旧DocumentのControls／SaverとDocument単位の表示・要求を破棄する。Workspace ownerは保持し、ルート更新後に対象Assetの詳細が準備できた時点で同じWorkspaceへ `openRawDocument()` を送る。Close応答の確認前に次Openを送らない。
5. 新DocumentのSettingsを読み、`install()` で新しい `RawControls`／`RawRecipeSave` を作り、History取得とViewerを初期化する。旧DocumentのHistory cursorやControlsを再利用しない。入力は新ownerの準備完了まで抑止する。

通常の切替、Filmstrip除外とUndo、ブラウザ履歴によるAsset route変更は同じ所有queueのDocument交代を通す。画面の `switchingRef`／`switching` は保存から新Documentの準備または失敗が確定するまで維持し、連続クリックやショートカットは既存Filmstripのdisabledとガードで拒否する。予期しないunmountやroute変更でも終了ownerが保存と回収を管理し、古いOpen結果を採用しない。

### 画像応答とWorkspace終了

`dispose()` のAsset単位部分は `invalidateDisplay()`、Preview／Regionのcancelと `RawRegionDelivery.dispose()`、`RawRegionOverlay.dispose()`、Blob URLの回収を行う。Workspace全体の `abortRawWorkspaceRequests()` はDocument切替で呼ばない。Document単位のAbortControllerで未送信・待機中の表示要求を中止し、送信済みNative処理はBackend Closeの排出を待つ。通信abortをClose完了の証拠にはしない。

`current()` のAssetとserial、Controls／Saverのowner、Workspace ID、Document handle・generation・token・revision、Preview serial・displayGeneration・viewGenerationとRegion identityを維持する。レスポンス受信時と画像decode完了時の双方で現在のownerを再確認する。Beforeは現行の `beforeOwner` と `beforeKey`、generation・tokenを使い、同じgeneration内のA→B→Aでも旧Aの結果を採用しない。`install()` の `region.resetDocument()`、surface・frame serial・geometry・表示URLの初期化と、`AnshitsuPage` のAsset単位Viewer／Controlsの初期化を維持する。旧画像やHistoryを次Assetの準備完了前に表示しない。

Home退室とDesktop終了は従来の保存ガードを通し、保存確定後にWorkspace全体の `releaseRawWorkspace()` を実行する。Asset切替のcleanupはDocument Close、暗室終了のcleanupはWorkspace Releaseを選ぶ。予期しないunmount、`pagehide`、Desktop終了取消、明示Discard、Point Color Finish／Cancel途中も、既存 `RawWorkspaceTermination` とSaverが処理を所有し、確定できない保存を成功扱いにしない。Release／Discardの応答不明は `rawWorkspaceEmpty()` と既存ownerの再試行で確認する。

heartbeatはDocumentが有効な間、既存の `readRawDocument()` を使う。CloseからOpenまでの空Document期間にはDocument heartbeatを送れない。通常切替は連続した処理として短く保ち、Open失敗等で長く空になる場合は180秒のBackend lease失効を許容し、後の再試行時に `rawWorkspaceEmpty()` で空を確認して新Workspaceを取得する。空Workspaceを維持する新しいheartbeat APIはP1-3では追加しない。

### 失敗と再生成

| 状況 | Frontendの処理 |
| --- | --- |
| 保存失敗・結果不明 | 旧Document、Saver、未確定の保存要求を保持する。既存のRetry／stay／明示Discardを使い、Closeと次Openを開始しない。 |
| Closeが送信前に拒否 | 旧ownerと固定したClose識別情報を保持し、既存の失敗表示から再試行する。revision競合は再同期・保存確認を先に行う。 |
| Close応答喪失 | 新Documentを開かず、固定した同じowner・revisionでCloseを再送する。receiptによる204を確認した後だけ進む。Workspace全体のempty判定だけでDocument Close成功と見なさない。 |
| Close後のOpen失敗 | BackendはOpen失敗時にWorkspace全体を解放し得る。Workspaceのempty／cleanup状態を確認し、未回収なら既存ownerによるRelease再試行を待つ。回収確認後に新Workspaceを作り、保存済みRecipe／Historyから対象AssetをOpenする。失敗した旧Documentは復活させない。 |
| Open応答喪失 | Openが成功していても新handleが得られない。Workspaceにownerが残る可能性を考慮し、既存Releaseの再試行とempty確認で全体を回収し、新Workspaceから再Openする。結果不明のまま次Openしない。 |
| 3枚目・容量上限 | `raw_session_capacity` のOpen失敗後、上記のWorkspace回収を確認し、新Workspaceで対象Assetを再Openする。再生成後も失敗する場合はエラーを表示する。 |
| 変更予算200／256 | `RawRecipeSave` と `restart()` の200 soft thresholdで入力を停止し、最終readbackと保存ACKを確定してからWorkspace全体をRelease・再生成する。新generation、保存済みRecipe revisionとfingerprintを照合して `install()` する。256拒否やNative結果不明では既存のRetry／回復を使い、未確認の値を保存済みとしない。 |
| Native障害・明示Discard | 既存のSession喪失、`discardRawWorkspace()` と回収経路を使う。旧ownerが参照する原本の回収確認前に新ownerを作らない。 |

WindowsのLightCraft方針ではRAWとJPEGの両方がNative Documentなので、RAW→JPEG→RAWでも同一Workspaceを利用し、同じResident上限を適用する。DockerのJPEG方針では既存のJPEG保存・Renderer経路を使う。形式自体でWorkspaceを切り替えない。

### 実装工程と最小回帰

1. **Workspace所有期間とAPI**。対象は `useRawDocument.ts` のWorkspace owner／cleanup、`rawApi.ts` のClose、`rawWorkspaceTermination.ts` の既存所有処理。Asset切替時にWorkspaceを保持し、暗室終了時に一度だけReleaseする。最小回帰は同じWorkspaceでのClose／Open、`activeDetail` の一時欠落、unmount中の終了owner、Closeのヘッダーと応答喪失再送。
2. **保存からDocument交代までの接続**。対象は `AnshitsuPage.tsx` の `activateAsset()`／`excludeAsset()`／退室ガードと、`useRawDocument.ts` の `prepareSave()`／`install()`。保存ACK→Close→次Openを直列化し、確定revisionを使用する。最小回帰は保存失敗・Retry、History／Point Color・Curve・Mixer途中の離脱、Close失敗、連続切替と除外Undo。
3. **表示の失効と異常復旧**。対象は `useRawDocument.ts` のPreview／Region／Before、`restart()`／`dispose()` と既存Workspace回収。旧ownerの遅延response・decodeを棄却し、Close応答喪失、Open結果不明、3枚目の容量到達、200到達・再生成失敗を回復する。最小回帰は同generationのA→B→Aでの旧画像棄却、送信中画像とClose、empty確認前の再Open抑止、200／256、RAW／JPEG混在とDocker JPEG。

P1-3の設計上の未決定事項はない。実装時はroute変更やunmountが既存queueを迂回しないこと、およびOpen成功応答喪失からの回収を重点的に確認する。

## P1統合検証とWindows Desktop実測

`b5296dd` の統合検証では、Backend focused 38件、Frontend focused 204件（Hook 194、画面6、API／JPEG renderer 4）、TypeScript、差分チェックが成功した。BackendはWindowsのリポジトリ内Python 3.14を権限付きで実行した。Frontend既存テストにReactの `act(...)` 警告があった。この自動検証では、同一Workspace ID・generationでのA→B→AとImport回数、保存済みRecipe／History cursor／fingerprintの復元、Close再送と旧画像の排除、上限・結果不明時の回復、LightCraft／Docker JPEG経路を確認した。主な根拠は `test_raw_history_api.py` の `test_document_switch_reuses_resident_and_restores_history_cursor`、`test_raw_recipe_restore.py`、`test_windows_raw_api.py`、`useRawDocument.test.tsx`、`AnshitsuRawPreview.test.tsx`。

### 計測対象と結果

2026-11-21の提供ログ2本を使用した。ファイル名の時刻はUTC。ケースと画像形式は測定時の説明に従い、ログ中ではAsset IDで照合した。以下の「初回」は各ログ区間内での初回訪問。Aは両ケース共通のDNG（Asset ID先頭 `46b4db82`）、Bはもう一方のDNG（`a6523bda`）、JはJPEG（`eae5ece5`）。

- Frontend `raw / preview.received` の `responseWaitMs` は `rawApi.ts` で計測するPreview HTTP要求開始から応答受領まで。本文読み取りと画像decodeは別計測。クリックから画面表示までの所要時間ではない。
- Backend `lightcraft / preview.measured` の `nativeMs` は `lightcraft_raw.py` のNative呼び出し直前からPreview readback・geometry取得とlock解放までの区間。Backend応答検証の `validationMs` は別項目で、GPU処理時間単体の指標ではない。
- `raw.document.ready` のgeneration・revisionでDocumentを特定し、両側のPreviewをgeneration・revision・kind・quality・要求長辺で対応させた。各DocumentでAfter／Fullが2件あり、Frontend serial 1が1024px、serial 2が1472px。表はms、小数1桁。Open→readyはBackendイベントの時刻差で、原本確保と復元を含み得る。

| ログ・訪問順 | generation / revision | Open→ready | 1024 FE待ち | 1024 BE Native | 1472 FE待ち | 1472 BE Native |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 124935Z A初回 | 2 / 11 | 403 | 2896.6 | 2869.0 | 176.0 | 132.7 |
| 124935Z B初回 | 2 / 13 | 395 | 1007.2 | 983.5 | 179.0 | 134.5 |
| 124935Z A再訪 | 2 / 14 | 108 | 129.9 | 105.2 | 177.3 | 134.5 |
| 124935Z B再訪 | 2 / 15 | 20 | 130.4 | 106.2 | 228.7 | 140.7 |
| 125017Z J初回 | 3 / 16 | 244 | 2156.0 | 2124.6 | 182.1 | 135.4 |
| 125017Z A初回 | 3 / 18 | 416 | 1049.3 | 1024.6 | 177.8 | 134.9 |
| 125017Z J再訪 | 3 / 19 | 109 | 100.7 | 76.6 | 163.0 | 99.9 |
| 125017Z A再訪 | 3 / 20 | 20 | 129.6 | 105.3 | 182.2 | 136.6 |

出所は `genzoroom-all-logs-20261121T124935Z.json`（A→B→A→B）と `genzoroom-all-logs-20261121T125017Z.json`（J→A→J→A）。各画像の1024px再訪PreviewでFrontend待ち・Backend Native時間の両方が短くなった。1472pxの追加Previewでは全画像に共通する短縮は見られない。P1適用前との同条件比較や所要時間の分布は、この2本からは算出できない。

### 所有権・永続化・異常

- 各ログ区間の4回のOpenは同一Native generationで完了した（順に2と3）。区間内にSession再生成・結果不明・再試行のイベントは見当たらない。ログ間でgenerationは異なるが、変化の理由は記録範囲外。ログにWorkspace IDがなく、IDの一致そのものは自動テストの証拠に限られる。
- BackendのImmich `request.start`／`request.response` では、各ログで各Assetの `/original` は初回に1件ずつ成功し、再訪時の追加取得は記録されていない。これは原本コピーの再利用と整合する。Native `library.import`／`library.select`、PhotoId、Resident hit/missは記録されていない。Native再Import省略は `open_raw()` の分岐と自動テストで確認し、実測ログだけからは確定しない。
- DNG同士では `raw.recipe.restored` が4件。混在ではJPEG初回のみ `raw.recipe.none`、残る3回は `raw.recipe.restored`。両ケースとも各訪問でBackend `raw.history.saved` が成功し、cursor／lengthは全件0／0。非ゼロcursorの復元や設定fingerprintの一致は実測対象外。Backend `preview.measured` のPNG SHA-256は同じ画像・長辺の初回と再訪で一致したが、これは画像出力の一致であり設定fingerprintとは別。
- errorレベルは両ケース0件。各Openで `raw.lensProfileInfo.unavailable`（`lightcraft_tool_error`）が計8件あり、各回ともDocument readyとPreview成功へ進んだ。初回1024pxに上表の長い待ちがあり、その後の再訪ではタイムアウトや同程度の待ちは観測されなかった。警告の原因、他の待ち時間、容量超過時の実機回復はこの測定では確認していない。

## P2 Resident管理の事前調査

目的は多数の写真を順に開き、少数の写真へ戻る利用でも、Resident容量だけを理由とするSession再生成を避けること。根拠はLightCraft v0.20.0固定commit `192ff72923c39e6623f2c7ff67ab3a119deb8071` のローカルGitオブジェクトと、[manifest](../../../native/lightcraft/manifest.json) が指定する [managed patch](../../../native/lightcraft/patches/0001-v0.20.0-whole-frame.patch)。patchのSHA-256はmanifestと一致した。以下はソース調査で、退役APIの実行やメモリ実測は行っていない。

### Nativeの状態と回収境界

| 項目 | 固定upstreamとGenzoRoomで確認したこと |
| --- | --- |
| PhotoIdとResident | `crates/mcp/src/headless.rs` の `Headless` はEngineの `Session` を1つ保持し、`library.import`／`library.select` は同じカタログと選択を操作する。`crates/catalog/src/lib.rs` は単調に進む `next_photo` からPhotoIdを割り当てる。GenzoRoom側の `_photos` はsource keyからPhotoId・原本パス／fingerprint・Import既定値等への対応、`_resident` は登録済みPhotoId集合。公開Documentは1件で、再訪でも新tokenを発行する。 |
| 既存削除API | `crates/engine/src/cmd/library/specs.rs` の `photo.delete` はRecently Deletedへの移動。`photo.deletePermanently` は指定写真をカタログから除去し、`library.emptyRecentlyDeleted` は一括処理する。どちらの恒久除去も `Session::commit` を使う。`photo.delete` と `photo.deletePermanently` は処理前にinteractionを終了する。用途に合う安全な個別退役APIはupstream／現行patchに見当たらない。 |
| Native History、Undo、ログ | `Catalog::delete_photos_permanently_ops` はアルバム・スタック参照を整理して `Op::RemovePhoto` を生成する。逆操作の `AddPhoto` は写真（設定とNative Historyを含む）を保持し、`Session::commit` は逆操作をUndo、順方向を `pending_log` に積む。Undoに件数上限があっても削除直後の解放は保証されない。永続ライブラリがなければ `run_command` の永続化分岐・`close_library` のflushは働かない。コマンド `journal` は別の領域であり、こちらも計測対象。SQLiteのGenzoRoom HistoryはこのNative状態から独立している。 |
| CPU／GPUと原本 | `Session::apply_through` は `RemovePhoto` 時に `media.forget(id)` を呼び、`media/cache.rs` でデコード済みthumb／preview／fullを外す。これは他のキャッシュ、Beforeマップ、実行中jobの共有参照、GPU allocatorまで一括解放する契約ではない。CPU `StageCache` はview／jobに渡す任意のキャッシュでGPU extensionを持てる。通常の `render_job` は `stages: None` で作成され、現行のmanaged HeadlessのWhole／Region経路は標準jobを実行・acceptする。UIのview用StageCacheと、headlessでのデコード再利用やGPU buffer poolを同一視しない。 |
| 予算 | GenzoRoomがImport時に指定する `app.memoryBudget` 1024 MiBはLightCraft内部のキャッシュ等への配分。process working setやGPU全体の上限ではない。RawSourceCacheは別のディスク予算（1原本512 MiB、Workspace合計1 GiB、空き容量の検査あり）を持ち、P1ではWorkspace終了までコピーを保持する。変更試行はPhoto単位ではなく `LightCraftRawSession._edits` に集計し、Recipe復元のNative変更も消費し得る。200はFrontendの安全な再生成閾値、256はBackend adapterの上限。退役でリセットしない。 |

### 推奨案と成立条件

| 方式 | 多数の写真を扱う場合の評価 |
| --- | --- |
| Resident上限だけを増やす | 固定枚数内の再Importは減る。訪問した写真と原本コピーが蓄積し、新上限／ディスク上限で従来どおり全体回収が必要。枠数を増やすだけでは容量超過時のSession再生成を解消できない。 |
| 有界Resident＋個別退役・入替 | 最近使った写真を保持し、空きがなければ安全に退役できる最も古い写真を除いてから次の写真をImportする。同一generationで総訪問枚数をResident枠より大きくできる。退役済みの再訪にはImportとSQLiteからの復元が必要。Nativeの参照回収とディスク予算を実証できれば採用する。 |

**ソース上は同一Sessionでの入替が成立し得る。** カタログ除去とデコード済みソース無効化を再利用できる。PoCでは永続ライブラリを持たないGenzoRoom専用Headlessに限定し、明示PhotoIdを受け取るmanaged toolとEngine内の小さな専用処理を候補にする。永続ライブラリやinteraction中は拒否し、原本、sidecar、Immich、SQLiteに書き込まない。通常の `commit` を経由せず、既存のカタログ除去・キャッシュ無効化を通して逆操作を保持しない。選択／previous active、Before、設定hash、メディアキャッシュとその他のPhotoId参照を点検する。最後に選択していたNative写真でも、HTTP Document Closeと全lease排出後なら安全に選択解除して退役できるか、PoCで確認する。

既存Undo／Redoにはインポートや複数写真を含む操作が入り得る。個別の記録を安易に部分削除せず、GenzoRoom専用の一時SessionでNative Undo／Redoと不要なpending logをまとめて破棄できるか検証する。永続ライブラリや未確定操作には適用しない。GenzoRoomのUndo／RedoはSQLite Historyとして維持し、新PhotoIdのImport時に既定設定・Beforeを再取得してRecipeとHistoryを復元する。Native Undoの整理に必要な変更の規模、補助キャッシュの全参照、GPU共有資源の残留量は未確定。個別退役が成功してもプロセスのworking setがその場で減ることまでは前提にしない。

### Backend／Frontendへの接続案

- Backendの退役はClose成功後のDocumentなし状態で、Workspace ownerの下でOpen admissionと直列化する。最新の保存チェックポイントが確定し、対象のPreview／Region／Before処理、送信lease、Native job、Curve／Mixer／Point Color／Geometry操作が残っていない写真だけを候補にする。使用順はOpen成功時に更新し、容量逼迫時は退役可能な最古を選ぶ。Native ACKと旧PhotoIdの不在を確認後に `_photos`／`_resident` を更新する。退役結果不明なら追加Importや原本削除を止め、既存のWorkspace回収・再生成経路へ渡す。
- 原本コピーのディスク管理はResident管理と分ける。短期再訪向けにコピーを残す場合もWorkspaceの既存バイト上限内に収める。空きが不足したら、Nativeが参照しないと確認済みで、ダウンロード・jobの所有もないコピーだけを古い順に回収する。コピーがあればfingerprintを照合して再Importに再利用し、なければImmichから再取得する。退役を越えたPreview PNGの再利用や先読みは別工程。
- 最初のPoCはResident 2枠のまま入替を検証する。本番枚数は代表的な高画素DNG／JPEGと長時間巡回で、CPU private bytes／working set、GPUメモリ、Native内部カウンタ、ディスク占有量、再Import頻度を別々に測って決める。枚数ガードとバイトガードを併用し、既存のNative memory budgetを総メモリの上限に流用しない。実測に基づく初期値や追加のメモリ上限は未決定。
- Frontendは既存の保存→Close→Openと表示ownerを再利用する。通常の入替が同じOpen契約に収まれば操作UIの変更は不要。容量エラー時の既存回復は、退役不能・結果不明のフォールバックとして維持する。200／256はSession累積のままとし、容量による再生成の削減と変更試行による再生成の削減を別に検証する。

### 最小PoCと実装順

1. **Native単体PoC。** 固定commit・managed EXEで2枠にA／BをImportし、退役→C→A再Importを同一プロセスで実行する。同じNative Sessionで非退役写真のIDと設定が維持され、退役IDがinspect／render／selectで使えず、再Importで有効な新IDが発行されることを確認する。原本とsidecarの非変更、編集中／永続ライブラリでの拒否、カタログ・Before・Undo／Redo・pending log・キャッシュ参照を確認する。
2. **長時間巡回と上限の決定。** 枠数を大きく超えるDNG／JPEGを読み直し、サイズの異なる原本、高画素、GPU利用有無、Before／Regionを含めてメモリ・ディスクの傾向と失敗境界を測る。容量要因を単独で測る試験と、編集・復元で200／256に達する試験を分ける。累積増加の原因が残る場合は修正範囲を見直し、必要なら再生成を残す。ここでmanaged APIの確定と実装着手可否を判断する。
3. **Backend接続。** 退役所有権とACK検証をNative adapterへ追加し、Open admission、Resident LRU、原本コピーの回収を接続する。保存未確定、画像lease排出、退役応答喪失、Import失敗、ディスク上限、200／256、再訪時のRecipe／非ゼロHistory cursor／fingerprintをfocused testsで検証する。
4. **統合確認。** 現行Frontendで枠数を超える連続切替、退役後の再訪、失敗時の既存回復、旧画像の排除を確認する。Windows DesktopでSession／generation・Importの有無を取得できるよう診断を整え、初回訪問、Resident hit、退役後の再Importを区別して計測する。
