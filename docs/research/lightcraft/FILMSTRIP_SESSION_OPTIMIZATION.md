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

## P2-1 Native APIの適合性とResident入替契約

基準はGenzoRoom main `9ecc38bf25455b5a8a9f64cf8b2fdea9339d3853`。LightCraft v0.20.0の固定commit `192ff72923c39e6623f2c7ff67ab3a119deb8071` と、[manifest](../../../native/lightcraft/manifest.json) が指定する [managed patch](../../../native/lightcraft/patches/0001-v0.20.0-whole-frame.patch) を参照した。patchのSHA-256はmanifestと一致した。P1の実測は同一generation内での再訪を対象としており、容量到達後の退役はこの節のソース調査と次工程の検証対象である。

### 既存APIでできること

Headlessは1つのEngine `Session` を保持する。MCPのコマンド実行は `crates/mcp/src/tools.rs` から `headless.rs` の `engine.execute` を経て同じSessionに届く。既存managed patchはWhole／Region、Before等の描画契約を拡張しており、Residentの退役や入替を追加していない。

| 操作 | 固定版の判定と根拠 |
| --- | --- |
| 同一SessionへA・BをImportし、A→B→Aと再訪 | **可能。** `library.import` の `mode: add` で写真を登録し、`library.select` に明示IDを渡して再訪する。P1ではこの経路を使用済み。Engine内のカタログIDはSession内で採番され、GenzoRoomのDocument tokenはOpenごとに更新する。 |
| Aを安全に退役 | **不足。** `photo.delete` はRecently Deletedに移す。 `photo.deletePermanently` はAをカタログから除去できるが、Aの状態をUndoに保持する。 `library.emptyRecentlyDeleted` も対象範囲が一括で、同じUndo付きcommitを使う。 |
| BのPhotoIdと編集状態を維持 | **条件付きで可能。** Bを選択した状態でAのみを明示指定する場合、独立したBの設定を削除処理は書き換えない。スタック・アルバム等の関連は更新され得る。Aが選択中の場合は削除後に選択が移る。編集中は削除API自体がinteractionを終了するため、A／Bとも未確定操作のない条件で確認する。 |
| CをImportし、Aを再Import | **条件付きで可能。** 恒久除去後にAのパス・内容が他の登録写真と重複せず、UndoでAを戻していなければ、`import/commit.rs` の新規登録経路が新しいIDを割り当てる。重複報告やRecently Deletedからの復元を新規Importとして扱わない。 |
| Session／generationの維持 | **カタログ操作としては可能。** 上記コマンドはSessionを作り直さない。ただし現行GenzoRoomは3枚目を制限する。既存APIだけでは有界なResident入替に必要な保持状態と回収の契約が揃わない。 |

LightCraftには独自のメモリ予算とメディアキャッシュの回収がある。 `app.memoryBudget` は `crates/engine/src/memory.rs` でプロセス内の予算とSessionのキャッシュ配分を設定する。これはカタログから写真を退役させるAPIではない。 `library.browse` と `library.forgetLocal` はLocalの未変更レコードを対象にし、期間、表示、選択、Before、Undo／Redoなどの保持条件を持つ。通常Importした編集済み写真を指定して入れ替える用途には使えない。対象のHeadless／通常Import経路には、容量に応じて通常写真を自律退役する公開契約は見当たらなかった。

### 恒久削除を採用しない根拠

- **Catalog・選択。** `crates/engine/src/cmd/library/specs.rs` は対象を解決し、`end_interaction()`、`Catalog::delete_photos_permanently_ops`、`Session::commit`、`select_after_deletion` の順に進む。 `RemovePhoto` はIDをカタログから除去し、逆操作 `AddPhoto` に写真全体を持たせる。選択は残存IDに整理され、アクティブ写真が変わると `run_command` が旧IDを `previous_active` に記録し得る。
- **Undo／Redo・ログ。** `Session::commit` は逆操作をUndoに積み、既存Redoを破棄し、順方向の操作を `pending_log` に保持する。Undoによって旧IDと設定・Native Historyを復元できる。退役操作だけをUndo対象外にしても、既存Importは `AddPhoto` をpending logに積み、既存編集や複数写真操作が旧IDを参照し得る。 `run_command` のメモリ上のコマンド `journal` と、永続ライブラリのディスクjournalは別。永続ライブラリ付きでは `persist()` が働き、保存失敗でもメモリに操作が適用済みの場合がある。一時Headlessではその永続化分岐が働かないため、ディスクに出ないことはメモリ内保持が消える根拠にならない。
- **Before・キャッシュ。** `Session::apply_through` は `RemovePhoto` で `media.forget(id)` を呼び、デコード済みthumb／preview／fullを無効化する。 `cmd/before.rs` の独立した `Session.before` マップに対する消去はこの経路にない。写真側の設定・HistoryもUndoで残る。共有job参照、CPU／GPUキャッシュの割当やプロセスの常駐メモリが即時に減ることまでは保証されない。
- **Preview／job。** Headlessの描画呼び出しは `&mut self` を取り、現行Whole／Region経路は呼び出し内でjobを実行する。恒久削除自体はすべてのNative jobの参照終了やHTTP画像leaseを確認するAPIではない。GenzoRoomのDocument Closeによる画像task・送信leaseの排出と、Native側での残存job参照の確認が必要。
- **原本・sidecar。** 恒久削除のコマンド本体はカタログを変更し、原本の移動や削除を直接呼ばない。 `run_command` にはXMP自動書込みが有効な場合の処理があり、`auto_write_sidecar_ids` はカタログに現存する対象を扱う。削除と再Importの一連の操作を無副作用とみなすには、モード `add`、自動書込み無効、一時Session、interaction終了済みの条件を固定し、PoCで原本とsidecarを比較する。通常の永続ライブラリの削除をP2の退役に転用しない。

### 採用方針と代替案

| 案 | 判定と変更範囲 |
| --- | --- |
| 既存APIの組み合わせ | **比較用。** 差分なしで選択・恒久除去・再Importを検証できるが、旧IDの復活と写真資源の保持を防げない。Local整理、Recently Deleted、キャッシュ予算の操作を組み合わせても、通常写真の安全な退役にはならない。 |
| 既存削除APIへのオプション追加 | **不採用。** カタログ除去は再利用できるが、Undo・永続化・副作用を切り替える別契約が必要になる。通常の削除入口に一時Session専用分岐を持ち込み、upstream更新時に既存削除との互換確認が増える。 |
| 一時Headless専用の個別退役入口 | **P2-2の推奨。** MCPで明示PhotoIdを受け、Engineの一時Session処理に委譲する。差分の候補はHeadlessの入口とEngineの退役処理。既存カタログの関連整理、`apply_through` のメディア無効化を活用する。通常の削除・永続ライブラリ・UIの経路を共用の特別モードにしない。 |
| Nativeによる容量判定と自律入替 | **個別退役が成立した後の採用候補。** Nativeの入場判定と候補選択で容量を管理すれば、GenzoRoomにLRUは要らない。頻度管理、入替とImportの失敗境界、退役ID通知が必要になり、個別退役より差分・移植負担が増える。初回PoCは明示IDで退役の意味だけを検証する。 |

### 退役と呼び出し側の契約

1. **受付。** GenzoRoomは既存の保存確定→Document Closeで、操作とPreview／Region／Beforeを排出し、画像応答lease終了を待つ。DocumentなしのWorkspaceでOpenと直列化する。Nativeは管理対象の一時Headless Sessionに限り、明示した対象IDの存在を確認する。永続ライブラリ、編集中、対象を参照する処理が残る場合は変更前に拒否する。PoCではBを選択し、非アクティブのAを退役する。選択中の写真の退役は初回契約に含めない。
2. **成功。** NativeはAのIDをカタログとSession内の参照から外し、AのBeforeや選択関連の参照を整理する。BのID、編集設定、Native HistoryとBeforeは維持する。退役IDがUndo／Redoで復活せず、pending logが旧写真を保持し続けないことを検証する。Native側で記録方針を決める。専用の一時モードでNative Undo／Redoと不要なpending logをまとめて整理する方法も候補とし、複数写真を含む操作をID単位で安易に切り取らない。通常モードのUndo／Redoには適用しない。コマンドjournalの扱いと、以後のImport／編集による再蓄積も確認する。
3. **受領と再Open。** Nativeの成功応答で退役済みIDを明示する。GenzoRoomは対応表のみ更新し、退役した写真を再訪する場合は既存のImport、原本照合、SQLite Recipe／History復元を使う。退役結果が不明なら追加Importと該当原本コピーの回収を止め、既存のWorkspace解放・Session再生成経路を使う。副作用なしと分かる拒否と、適用済みか分からないエラーを区別する。
4. **製品での入替。** 容量到達時の候補選択と内部リソース管理はLightCraftが担当する。PoC成功後に、Nativeが候補と結果を明示する方式と、NativeがImportの一部として退役し結果に退役IDを返す方式を比較する。どちらも公開中のDocumentの写真を暗黙に無効化しない。Importに失敗した場合も確定した退役結果を返せることが条件となる。容量だけでSessionを作り直さずに済む可能性はあるが、容量制御と参照回収がPoCで成立するまで製品契約とはしない。

### GenzoRoom側の責務と見直し対象

LightCraftは現像・描画・Export、写真カタログ、Resident入替とCPU／GPU資源の寿命を管理する。GenzoRoomはUI、現像パラメーター、Recipe／History、Immich、Document／Workspaceの所有と、保存・直列化・通信失敗の回復を担当する。

| 現行制御 | 分類とP2での扱い |
| --- | --- |
| `LightCraftRawSession._photos`／`_resident` | `_photos` のAsset・原本・Import既定値・PhotoIdの対応はアプリケーション制御。 `_resident` は現在の登録確認に使う複製状態。Nativeが退役結果を返す場合はその結果に従い、独立した追跡集合が必要か見直す。利用順管理は追加しない。 |
| `MAX_RAW_FILES = 2` | P1の安全制約。代替のNative入場／退役契約が検証できてから見直す。枚数を増やすだけの案では、次の上限で再生成が必要になる。 |
| `app.memoryBudget` | LightCraft公開APIの利用。現行adapterは初回Import前に1024 MiBを指定する。これは写真枠や総CPU／GPUメモリの上限を表さない。PoCでは同条件で観測し、GenzoRoomに別予算や資源解放命令を設けない。 |
| StageCache設定 | 現行adapterの `GENZOROOM_RAW_STAGE_CACHE` と予算は初期化時に検証・保持するが、その値をNativeへ渡す利用箇所は確認できない。固定版の該当Headless job構築は `stages: None`。設定を退役設計の前提にしない。 |
| `reset_session()` | GenzoRoomの障害・結果不明・変更予算からの回復。正常な容量入替の成功時には不要。 |
| Document Close→Open | アプリケーション制御。 `RawPreviewApi._close_document_owned()` の保存チェックポイント、task／lease排出、owner失効を利用する。Frontendの通常切替契約は既存のまま接続できる見込み。 |
| `RawSourceCache` | Immich原本コピーの所有、同一性、ディスク上限の管理。現行は1原本512 MiB、Workspace全体1 GiB。Nativeが参照しないと分かる前に削除しない。多数の写真でディスク上限が先に効く場合の原本コピーの寿命は後続のBackend設計で扱う。Nativeのメモリやキャッシュ管理から独立させる。 |
| 変更予算200／256 | P1のSession単位の安全制約。200はFrontend再生成閾値、256はadapterの上限。Recipe復元でNativeの変更試行を消費し得る。写真退役ではリセットせず、容量入替の成否と分けて扱う。 |

### P2-2の開始条件と最小PoC

固定commitと現行patchを照合できる状態を起点とする。破棄可能なRAW／JPEG fixtureとsidecarを用意し、一時Headless、Import `add`、XMP自動書込み無効を確認する。PoC開始前に比較用の既存API操作と、専用入口での検証を分ける。数値上限や製品用の候補選択は、この段階の前提にしない。

| 検証 | 受入条件 |
| --- | --- |
| 退役patch不要の対照試験 | 同一HeadlessでA・BをImportし、A→B→Aを `library.select` のみで切り替え、ID、設定、Before、Previewを確認する。別の一時SessionでBを選択してAを恒久削除し、C ImportとA再Importが可能か確認する。Undoの検証は再Importと分け、削除直後にUndoして旧IDが復活することを確認する。pending log／journalの差分も記録し、カタログ除去と退役の違いを示す。 |
| 専用入口の正常系 | A・Bの登録後、Aを退役しCをImportする。2件を維持する巡回では次にCを退役してAを再Importする。処理全体で同一プロセス・Sessionを維持し、adapter経由の観測を行う場合はgenerationが変わらない。BのID・編集設定・History・Beforeが維持され、旧Aのinspect／render／selectは拒否され、新Aに異なるIDが発行される。新AでImport基準を取得でき、保存設定を再適用できる。SQLite連携は後続のBackend接続で検証する。 |
| 専用入口の保持状態・失敗 | Undo／Redoで退役IDが復活せず、pending logが退役写真を保持し続けない。journalとBefore・選択等の参照を確認する。未知ID・選択中・編集中・job参照中・永続ライブラリを拒否し、既知の拒否でBや選択・履歴を変えない。退役成功後のImport失敗と応答喪失を区別し、状態が不明なら同一Sessionで追加操作を続けない。 |
| ファイルと長時間動作 | 原本と既存sidecarの内容・存在が同じで、新規sidecarも発生しない。少数枠を越えて繰り返し巡回し、Nativeの参照・ログ蓄積を確認する。必要に応じてCPU／GPUメモリを観測し、allocatorに残る容量と写真への有効な参照を区別する。 |

未解決なのは、破棄できるNative Undo／Redo・pending logの範囲、残存jobと各種補助参照の判定、長時間巡回時の資源の傾向、選択中写真の扱い、製品用のNative入場契約、原本コピーのディスク寿命である。P2-2で個別退役の成功・拒否・結果不明を判別でき、保持する写真が無傷であることを確認してから、Nativeの容量制御とBackend接続の具体化へ進む。


### P2-2A 既存API対照試験の実測結果

実施日 2026-11-21。固定upstream `192ff72923c39e6623f2c7ff67ab3a119deb8071` を元にmanifest記載patchを適用して作成済みの `lightcraft-cli.exe`（`.tmp/lightcraft-sharpen-p1/target-p1-sharpen/release/lightcraft-cli.exe`）を使用した。PoC用Native変更・正式patch・manifestは加えていない。JSONLはPowerShell `ConvertTo-Json -Compress` で各リクエストを直列化し、Native CLIの `run --script <jsonl> --keep-going` に渡した。生成した各行は `ConvertFrom-Json` でも検査した。Sessionは `--library` を指定しない一時Headlessであり、`library.info` の `persistent:false` で永続ライブラリを使っていないことを確認した。

テスト用コピーは合成DNG A（24,938 bytes）、既存JPEG B（406,494 bytes）、別JPEG C（444,722 bytes）。元ファイルは読み取りのみ。実行前に各コピーのSHA-256は元fixtureと一致し、A/B/Cの隣接XMPは存在しなかった。

#### 成功した実行

| Session | 操作とNative応答 | 確認結果 |
| --- | --- | --- |
| 削除・再Import | A Import `imported:[1]`、B Import `[2]`、B選択 `selected:1`、`photo.deletePermanently(ids:[1])` は `deleted:1`。続く `photo.inspect(id:1)` は `no such photo 1` で失敗した。C Importは `[3]`、A再Importは `[4]`。 | Aの旧ID 1は削除後のinspectで拒否され、同じ一時SessionでCとAをImportできた。再Import AはID 4を取得した。これは恒久削除と新規Importの挙動であり、Nativeメモリ退役の証明ではない。 |
| 削除直後のUndo／Redo | 別SessionでA/BをID 1/2としてImportし、Bを選択、Aを恒久削除後 `edit.undo` は `undone:"Delete Permanently"`。inspect ID 1が成功し `deleted:false`、exposure 0、History空を返した。次の `edit.redo` は `redone:"Delete Permanently"`、inspect ID 1は `no such photo 1`。さらにUndoするとID 1が再びinspectできた。 | 削除のUndo操作が旧PhotoIdと写真状態を復元し、Redoで同じIDを再削除することを実測した。編集値はデフォルト値のままで、非デフォルト編集状態の復元はこの実行では検証していない。 |

#### 公開APIから確認できた範囲と未観測の内部状態

`library.info` は一時Sessionで `persistent:false`、写真数2を返した。Headlessコマンド実行で観測できるundo／redoの応答は上記のとおり。今回のCLI公開コマンドからpending log、メモリ内journal、Beforeマップの内容を直接列挙する方法は確認できず、数値や内容を実測結果として記載しない。永続ライブラリは開いていないためディスクjournalへの追記もこの試験対象外である。

ソース上は `Session::commit` が削除の逆操作をUndoへ保持し、順方向の `RemovePhoto` をpending logに積む。 `run_command` はコマンドID／引数をSessionのjournalへ記録し、永続ライブラリが開いている場合は `persist()` を呼ぶ。 `apply_through(RemovePhoto)` はmedia cacheをforgetする一方、独立した `Session.before` 参照の除去はこの経路にない。これは固定ソースの確認であり、当該コンテナの内容を実測したものではない。

#### 原本とsidecar

実行後のコピーのSHA-256とサイズは以下のとおり。コピー元と一致した。全fixtureで隣接XMPは引き続き存在せず、試験用ディレクトリ内に別sidecarも生成されなかった。

| Fixture | bytes | SHA-256 | 隣接XMP |
| --- | ---: | --- | --- |
| A.dng | 24,938 | `00FDAF88EFAED361056369C0612311A4B9F94C2BB6A3102CEF53EBF655A40942` | なし |
| B.jpg | 406,494 | `58AD0FE7C10ED3E7C54F07A3664449D04E54E87CEC7F268068934C1D0421CF6F` | なし |
| C.jpg | 444,722 | `428F38C740E98BF5A4D9D7A8CAAC93916B4469E82F62AEB73571DD584A13FDEA` | なし |

以上により、P2-2Aの削除・再Import、独立Undo／Redo、原本・sidecar比較は実行した。未検証は非デフォルト編集状態を含むUndo、Beforeの実行時値、pending log／journalの実行時内部内容、Nativeの内部PhotoId参照とCPU／GPU資源解放である。pending log等の観測には公開APIがなく、内部状態を露出する診断機能は追加していない。恒久削除はUndoで旧IDを復活させるため、安全なResident退役としては不適合というP2-1の判断を維持する。


## P2-2B Native個別退役PoC

### 実装と適用順

PoCはLightCraft v0.20.0 upstream `192ff72923c39e6623f2c7ff67ab3a119deb8071` に、manifest記載の現行managed patch `0001-v0.20.0-whole-frame.patch` を適用した後、GenzoRoom管理の [PoC patch](../../../native/lightcraft/poc/p2-2b-headless-photo-retirement.patch) を適用する構成。PoC patch SHA-256は `5EABCA72874338CDD0C338250F352CE24809975952123E8EBFCC7690918FE202`。正式manifest、正式patch、配布バイナリには含めない。patchはmanaged patch適用済みの固定upstream worktreeに対して `git apply --check` が成功した。

Engineの `Session::retire_headless_photo(PhotoId)` は永続library、未知ID、activeまたは選択中、interaction中を変更前に拒否する。成功時は既存 `Catalog::delete_photos_permanently_ops` を作り、通常の `Session::commit` を通さず `apply_through` で適用する。これによりCatalogの関係整理と `media.forget` による既存デコードcache無効化を利用する。Before、選択、previous-activeの対象IDを消し、Undo／Redo、pending log、command journalを一時Session全体で破棄する。Import／編集操作に含まれる逆操作から旧IDが復活しないことを優先したPoC上の制約で、残存写真のNative Undo履歴は保持しない。残存写真のカタログ内settingsとPhoto History、Beforeは保持する。

HeadlessのMCP transportに `headless.retirePhoto` とPoC tool `headless_retire_photo` を追加した。toolはUI接続時には公開しない。通常の削除commandは変更していない。最初の `lightcraft-cli run --script` 試行ではMCP用methodをEngine commandとして呼ぶためunknown commandになった。Native MCP stdioの `tools/call` から専用toolを呼ぶことで実行し、Headless専用境界を通ることを確認した。

### 検証結果

固定commitとmanaged patch適用済みの独立worktreeで `cargo check -p lightcraft-mcp --no-default-features` と `cargo build -p lightcraft-cli --no-default-features` が成功した。新しいCLIはversion 0.20.0。focused test `headless_photo_retirement_keeps_other_photo_and_drops_history_references` は1件成功した。テストはunknown ID、active写真の拒否、退役後のCatalog不在、残存写真のsettings／Native History／Before維持、Undo／Redo・journal・pending logの整理、同じIDへの重複退役拒否を確認する。

既存fixture A（合成DNG）、B（JPEG）、C（別JPEG）を使い、CLIのHeadless MCP stdioで一連の操作を実行した。

| 操作 | 結果 |
| --- | --- |
| A・B Import、A→B→A再選択 | A/BはPhotoId 1/2。Aはexposure 0.4、Bは-0.3に編集。A/Bとも再選択に成功。 |
| B選択中にAを退役 | `headless_retire_photo(id:1)` は `retired:1`。旧Aのinspect、select、render_photoはいずれも失敗。 |
| 残存Bの状態 | 退役前後ともID 2、exposure -0.3、Photo History length 1。退役後にBefore renderが成功し、before fingerprintを返した。Native focused testではBのBefore map保持も直接確認。 |
| CとAの再Import | CはID 3、A再ImportはID 4。旧AのID 1とは異なる。 |
| Undo／Redo | Import AのUndo／Redo後も旧A ID 1のinspectは失敗。退役時に旧Aを参照するNative Undo／Redoエントリ自体を消去した。 |
| 永続library拒否 | `--library` 付きMCP Sessionで同じtoolを呼び、`photo retirement requires a transient session` を返して拒否。 |

原本比較ではA/B/Cの実行後サイズとSHA-256が試験用コピー元と一致した。Aは24,938 bytes、SHA-256 `00FDAF88EFAED361056369C0612311A4B9F94C2BB6A3102CEF53EBF655A40942`。Bは406,494 bytes、SHA-256 `58AD0FE7C10ED3E7C54F07A3664449D04E54E87CEC7F268068934C1D0421CF6F`。Cは444,722 bytes、SHA-256 `428F38C740E98BF5A4D9D7A8CAAC93916B4469E82F62AEB73571DD584A13FDEA`。隣接XMPはどれも存在せず、sidecarは生成されなかった。

### 成立範囲と未解決事項

このPoCでは、一時Headlessの単一Sessionで非active写真をCatalogから除去し、Undo／Redoで同じPhotoIdが復活しない状態にして、残存写真を維持したままImportと再Importを行えた。通常のEngine削除APIと永続libraryは変更していない。

Engine処理は `&mut Session` 上で同期実行される。PoCはHeadlessの同期コマンド経路を対象とし、別threadが保持するRenderJob、activity/job内のPhotoId参照を列挙する公開APIは追加していない。interactionの拒否は実装とソースで確認したが、fixtureを使ったinteraction中の実行試験は未実施。Redo、pending log、journalの内容と対象Photo IDの非参照はNative focused testのSession内部状態で確認し、BeforeのB保持もfocused testで確認した。OSのworking set、GPU allocator、長時間反復時のメモリ回収は測定していない。選択中の写真はPoC契約上拒否する。Undo／RedoとlogをSession全体で破棄するため、この処理は一時Headless Sessionにのみ使える。

P2-3ではHeadless内の解放通知・候補選択と、同一Sessionでの反復退役／再Importをfocused testおよび実CLIで確認した。正式managed patch化の前にはinteraction中の拒否をfixtureで実測し、非同期Native jobとの安全境界、長期資源傾向、履歴全消去が一時Headlessで許容可能であることを追加確認する。P2-2B／P2-3のPoC patchは製品へ適用しない。


## P2-3 LightCraft Native側のResident自律入替PoC

### Native Undo／Redo・pending logの記録

固定upstreamとP2-2B実装を確認した範囲では、Headless SessionだけでUndo／Redoまたはpending logの記録を最初から無効化する公開Session設定は見つからなかった。Engineの `Session::commit` と各種operation適用がこれらを更新するため、記録停止にはEngineの広い操作経路を変える必要があり、Session整合性への影響をこのPoCで正当化できない。P2-3は記録方法を変更せず、P2-2Bの退役成功時に一時Session全体のUndo／Redo・pending log・command journalを破棄する方式を維持する。退役した写真の参照を残さず、通常Libraryや通常Undo契約に影響させないことを優先した。

### 入場・候補選択・退役契約

PoCはLightCraft v0.20.0 upstream `192ff72923c39e6623f2c7ff67ab3a119deb8071` にmanifest所定の正式managed patch `0001-v0.20.0-whole-frame.patch` を適用し、その後P2-2B [個別退役PoC patch](../../../native/lightcraft/poc/p2-2b-headless-photo-retirement.patch)、続けて [Resident入替PoC patch](../../../native/lightcraft/poc/p2-3-headless-resident-replacement.patch) を `git apply --unidiff-zero` で適用する。P2-3 patch SHA-256は `EF37C11FD497BB9DD77235BCCFF83904B225ED455C1A2BCEEAEDCB883FC62C09`。P2-3 patchはP2-2B後の差分で、変更対象は `crates/mcp/src/headless.rs`、`crates/mcp/src/tools.rs`、`crates/mcp/src/tests.rs`。正式manifest、正式managed patch、製品用Native binaryには含めない。

Headless MCPにPoC専用の `headless.release_photo(id)` と `headless.import_with_eviction(paths)` を追加した。前者は一時Session内にある非選択写真について、interactionがないことを確認して利用終了の通知を記録する。通知は退役そのものではなく、後続Importで候補にできるという意味である。保存確定・Document Close後にだけ通知する責任は呼出側に残る。後者は単一の写真をImportするHeadless専用経路で、Native側が管理するアクセス順から最も古い解放通知済みかつ非選択の写真を選び、既存のP2-2B退役処理を呼び出してから通常の `library.import` を実行する。候補IDや順序をGenzoRoomから渡さず、選択中写真、interaction中、永続Library、解放通知のない写真は退役させない。PoC上のResident数2は巡回を短く再現するための試験設定で、製品上限やLightCraftのメモリ予算値を決定するものではない。

成功応答は `{status:"ok", importedIds, retiredIds, error:null}`。候補不足やImport前の拒否は `status:"rejected"` で両ID配列は空。退役後にImportが失敗した場合、または上限を満たす前に候補が尽きた場合は `status:"partial_failure"` と確定済み `retiredIds`、空の `importedIds`、Nativeの失敗情報を返す。退役入口がエラーを返し変更結果が確定できない場合は `status:"unknown"` とし、既に確定した `retiredIds` と結果不明の `unknownId` を返す。呼出側は同Sessionを続けて使わず破棄する必要がある。この契約は成功した退役と新規Importの失敗を区別するが、応答自体がtransport上で失われた場合は、同じSession内の状態確認またはSession破棄が必要であり、要求の盲目的な再送を成功扱いしない。

LightCraft側Headlessがselection／importを監視し、最近使ったIDの順序と明示解放済みIDを保持する。個別のCPU／GPU管理、Native cacheの無効化、メモリ計測、独立したGenzoRoom LRUは追加していない。実退役時のCatalog整理と `media.forget` はP2-2Bの既存Engine処理を使う。Native通常APIの `library.import` や一般削除の意味は変更していない。

### 検証結果

固定upstream + 正式managed patch + P2-2B + P2-3の独立Native worktreeで `cargo test -p lightcraft-mcp --no-default-features headless_ -- --nocapture` を実行し、focused unit 6件と関連MCP integration 1件が成功した。Residentテストは合成PNGを使い、同一SessionでA/BをImport、A→B→Aを選択、解放通知済みの古い候補だけを退役してC/D/E相当を順次Import、退役IDを再利用せず、空き候補がないときはCatalog数を維持して拒否することを確認する。永続Libraryでは解放・入替の両APIを拒否する。Native CLIは同じPoC checkoutから `cargo build -p lightcraft-cli --no-default-features` でビルドした。

既存の合成DNG A、JPEG B、JPEG Cの試験コピーを使った実CLI MCP stdio試験も成功した。A/BはID 1/2でImportし、A→B→A再選択後、Aのexposure 0.4とBefore renderが保たれたまま、Bを退役してCをID 3でImportした。その後、別の解放通知を使ってAを退役しBをID 4で再Import、Cを退役しAをID 5で再Importした。旧ID 1はinspectで拒否され、A再ImportのID 5とは異なる。Aを退役した後のUndo／Redoでも旧ID 1は復活しなかった。Bは最初の巡回で退役対象だったため、ID 4での再Importは新しい写真としてImport既定値となる。GenzoRoomが保存済みRecipeを再適用する接続は今回の対象外である。候補がないときは `rejected`、解放通知したBの退役後に無効なJPEGをImportしたときは `partial_failure`、退役済みID `4` が応答に含まれることを確認した。

試験コピーのA.dng／B.jpg／C.jpgは実行前後でサイズとSHA-256が一致し、隣接XMP sidecarは存在せず、新規sidecarも生成されなかった。Undo／Redo・pending log・journalの整理はP2-2BのNative focused testでSession内部状態を検査済みであり、P2-3のCLI試験では旧IDが戻らないことを確認した。今回のCLI経路はHeadless内で同期実行されるため並行Native jobの退役競合を再現しておらず、CPU／GPU実メモリの即時解放や長時間巡回の資源傾向も測定していない。interaction中の拒否はP2-2B実装に基づき、P2-3専用のfixture実測ではない。

### 成立範囲・GenzoRoom接続と次の確認

LightCraft Headless内で「利用終了の通知→LightCraft自身による候補選択→既存退役→通常Import」の同期経路が成立し、退役対象を呼出側が選ばずに同一Sessionで複数回の入替を続けられた。GenzoRoom接続に必要となる最小契約は、保存確定・Document Close後のPhoto解放通知、`import_with_eviction`の結果中の新PhotoId／退役PhotoIdの受領、`partial_failure`／`unknown`時のWorkspace破棄判断である。Recipe／History永続化やSession再生成をNative側へ移すものではない。

これはNative API／Headlessの成立性をみるPoCで、製品のメモリ容量に対する最適Resident数、候補選択の長時間性能、async Native jobとの排他、transport応答喪失からの状態回復、正式MCP APIとしての互換性は未確定である。P2-3では製品用Capacity設定、GenzoRoom Backend接続、manifest／正式managed patch更新を行わない。正式採用時はP2-2BとP2-3を合わせてmanaged patch化し、UPDATE_GUIDEに従って固定upstreamへの順次適用、Native build、実binaryの契約確認、GenzoRoom adapter統合を別工程で行う。

## P2-4 LightCraft Resident自律入替の正式統合

### 製品patchと適用基準

P2-4はGenzoRoom main `a10f6338ef509c8b3d0fc332498cd74d6d8e48f3` を基準に実装した。LightCraftはv0.20.0、upstream commit `192ff72923c39e6623f2c7ff67ab3a119deb8071`。現行正式patch `native/lightcraft/patches/0001-v0.20.0-whole-frame.patch` にP2-2BのHeadless個別退役とP2-3のHeadless入替を統合し、重複targetの独立patchを作らない。製品への適用順は固定upstreamにこのmanaged patchを1回適用する。旧PoC patchは再現・履歴用として `native/lightcraft/poc/` に保持し、manifestの正式patch列には加えない。

統合patchは18 Nativeファイル、1100 insertions、37 deletionsを変更する。patch SHA-256は `ECF7C183FC4DB9D2F9DA679E2ACBB30720B0609E019BC073F5555F3495DFF723`。主な境界はEngine `Session::retire_headless_photo` とMCP Headless tool `headless_retire_photo`、`headless_release_photo`、`headless_import_with_eviction`。正式patchは従来の描画・Before・Region・WB・Point Color・Sharpening契約も含む。manifestのtarget/hashと固定upstreamからの適用を `build.py --source ... --apply` で確認した。

### Native APIと責務境界

- `headless_retire_photo({id})` は一時Headless Sessionの明示PhotoIdを退役する。永続library、未知ID、選択中またはactive、interaction中は拒否する。既存Catalog除去・media cache invalidationを使い、通常削除のUndo commitは通さない。Before、選択関連、HeadlessのResident順序／released集合から対象を除く。残存Photoのsettings、Photo History、Beforeは保持する。
- `headless_release_photo({id})` はPhotoを直ちに削除せず、利用終了をNativeへ通知する。Headlessの古い選択参照を除去し、再選択されたPhotoは入替候補から外す。応答は `{released: id}`。
- `headless_import_with_eviction({paths:[onePath]})` は一時Sessionに限る。Resident内のcanonical pathは既存PhotoIdを返して再利用し、他の写真を退役しない。新規Import時はLightCraft `Session::memory_report()` のEngine cache budgetが圧迫されている場合に限り、LightCraft内部の最近使われていない利用終了済み・非active・非選択Photoを退役する。枚数上限は設けない。新規Importの成功応答は `{status:"ok", importedIds:[id], retiredIds:[...], error:null, errorCode:null}`。既存Residentへの要求もそのPhotoIdを `importedIds` に含めるが、`errorCode` は省略される。
- 圧迫中に候補がない場合は変更なしの `rejected`。退役後のImport失敗は確定退役IDを含む `partial_failure`。重複原本拒否は `errorCode:"duplicate_source"`。退役結果不明は `unknown` として成功扱いしない。

LightCraftがPhoto順序、利用終了状態、候補選択、cache pressure、PhotoIdとNative media cacheを管理する。GenzoRoomはNative応答の確定PhotoIdだけをAsset対応へ反映し、CPU/GPU予算、LRU、Resident上限を持たない。Native Undo／RedoはGenzoRoom Historyの永続化に使わない。退役時に一時SessionのUndo／Redo、pending log、command journalを整理するP2-2B契約を維持し、残存Photo状態を保つ。

### BackendのClose／Open

`RawPreviewApi._close_document_owned()` は保存checkpoint後、画像taskと送信response leaseを排出し、ownerを再確認して `LightCraftRawSession.release_photo()` を呼んでからDocumentを失効させる。Workspace、Native generation、原本cacheは維持する。利用終了通知と実際の退役は別であり、Nativeは直ちにPhotoを削除しない。再訪時は `_photos` のPhotoIdでNative selectし、Residentなら再利用する。退役済みPhotoは `photo_id=None` となり、新Import IDへImport defaultsを起点にSQLiteの確定済みRecipe／Historyを復元する。

二重のResident集合 `_resident` と `MAX_RAW_FILES=2` を削除した。`_photos` はAsset、fingerprint、Import defaults、PhotoIdの対応を保持するアプリケーション状態であり、Native resource管理の代用ではない。退役結果不明、未知／重複ID、部分成功では確認済みIDを反映したうえでdesynchronizedにし、既存Workspace Release／Session再生成経路を使う。保存失敗時はCloseとrelease通知を行わない。変更予算200／256はSession単位のまま、Resident入替でresetしない。

`RawSourceCache` はImmich原本コピーを管理し、Native Residentとは独立する。本工程では容量と削除規則を変えていない。Nativeが参照中のコピーを先行削除しない契約を維持する。多数Assetではディスクcache上限が先に効くか、別途実測して判断する。

### 検証と残件

Backend focused suiteは指定Python 3.14環境で5ファイル373件成功。初回実行の4失敗は非active写真を編集する旧テスト手順、fixture再生成時の原本fingerprint不一致、重複原本応答、Recipe／Historyの期待値に関するもので、原因を修正して全focused範囲を再実行した。Native focused `cargo test -p lightcraft-mcp --no-default-features headless_ -- --nocapture` は7 unit testと1 MCP integration testが成功した。

固定upstreamの独立worktreeにmanaged patchを適用し、`native/lightcraft/build.py --source ... --apply --build` を実行した。Whole Frame、Crop、Region、WBのNative focused contract tests、Release CLI buildと既存Whole／Before／Region／WB／Point Color Range／Sharpening probeが成功した。更新後manifestでbuild gateを再実行し、Headless schema／response probeを含む `--binary` 検証も成功。実binary SHA-256は `535F30F311C42F596F4EC1E9E44A87DB64DED7BA5DA6F74A1A1464D362495BF7`。receiptは `headlessResidentContract:1` と現manifestを記録する。DX12 probeではRadeon RX 580 adapterが利用可能だった。未使用optional egui patch、craft-fonts未配置、Windows incremental hardlinkの警告が出たがbuild/testは成功した。

自動binary probeは実バイナリのtool schema、structured response、release→同一Session Import→retire契約を確認する。これはWindows DesktopのRAW/JPEG混在操作や性能測定ではない。実機写真負荷でのcache pressure発生点、長期多数Assetのメモリ推移、実transport応答喪失、原本disk cache上限はP2-5への未検証事項とする。

## P2-5 Filmstrip Frontend回帰・統合検証

### 確認した契約

Frontendは既存のWorkspace owner、`ownership` queue、保存確認、Close→Open、旧Document owner判定を使い、FilmstripのAsset交代ごとにWorkspaceを作り直さない。Workspaceは暗室を離れるときにReleaseする。LightCraft Residentの選択・保持・退役・再Import判断はBackend/native契約のままで、FrontendにResident集合やLRUを追加しない。Windows LightCraft方針ではRAW/JPEGともNative経路、Docker JPEG方針では既存JPEG rendererと編集経路を使う。

### 今回の自動検証

既存のFrontend focused tests 6ファイルに、FilmstripのRAW A→JPEG B→RAW C→A再訪を追加した。結果は6ファイル578件成功、失敗0件。追加テストではWorkspace作成が1回、4回のOpenが同じWorkspace IDを使い、旧Document A/B/Cを順番にCloseし、訪問中にWorkspace Releaseがないことを確認する。既存のFilmstrip混在形式テストは全AssetのNative Preview経路を、Docker JPEGテストは旧renderer経路を確認する。

同じfocused範囲の既存ケースで、保存確定ACK→Close→次Open、切替guard、保存失敗時の停止、Close失敗と固定ownerでの再送、連続切替中の最新Asset選択、route Back/Forward、暗室unmount／pagehide時のRelease、旧Preview／Region／Before応答とdecode結果の拒否、A→B→AのDocument token分離を確認した。Curve／Mixer／Point Color／Geometryの保存・interaction境界は既存Hook・Filmstrip testsで確認した。TypeScriptを含むFrontend buildと差分チェックも今回の変更後に成功した。

P2-4で成功済みのBackend focused 373件はBackend/nativeコードに変更がないため再実行せず、その結果を再利用する。うち `test_document_switch_reuses_resident_and_restores_history_cursor` はResident再利用時に同一generation、Recipe設定、History length/cursorを確認し、`test_native_eviction_reimports_asset_from_committed_recipe_and_history` は退役後の新PhotoId、確定Recipe revision、History cursor/lengthと設定復元を確認する。Frontendの新規テストはHTTP/UIのWorkspace・Document交代を対象にし、LightCraftの内部Resident判断を模擬・再実装しない。

### 異常系・実機確認の境界

Open失敗／`raw_session_capacity`、Workspace回収未確定、再生成時の保存・owner保持は既存Hook testsの対象。200／256変更予算のSession回復はP2-4 Backend focused結果を再利用する。Native `rejected`／`partial_failure`／`unknown` のNative実契約とResponse形状はP2-4のBackend接続・Native probe結果の範囲である。本工程はLightCraft Nativeの実画像処理やメモリ管理を試験していない。

この作業ではWindows Desktop実機、実写真のRAW/JPEG混在、長時間の多数写真巡回と性能、実際のcache pressureによる退役、実transport応答喪失は確認していない。P2-6では実写真でRAW/JPEG混在とA→B→A・多数枚巡回を行い、Workspace ID／Native generation、退役後のPhoto再Import、保存済みRecipe／History／Before、切替エラーの有無を確認する。初回表示、Resident再訪、退役後再訪のFrontend `responseWaitMs` とBackend `nativeMs` は対象イベントと出所を分けて記録し、200／256到達による意図したSession再生成と通常切替を区別する。P2-5の自動テスト成功を実機受入や性能改善率の証明とは扱わない。
