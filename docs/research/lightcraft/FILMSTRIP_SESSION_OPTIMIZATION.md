# フィルムストリップ切替とNative Sessionの寿命

基準はGenzoRoom main `0bd6018c2536889e89090868c0e69853b950a78f`。P0・P1事前調査とP1-1の実装結果をまとめる。P1-2の契約は確定済みで、実装は未着手である。

## 目的と計測

現像作業中のフィルムストリップ画像切替、特に訪問済み写真への往復を高速化する。Immichからの初回原本取得と初回Native Importの高速化は主目的ではない。

P0・P1事前調査では、画像切替に伴うNativeプロセス再生成と、同一Sessionの初回Previewと2回目Previewの時間差を調査対象とした。今回参照できる記録には、それぞれのログの計測値・測定条件・対象画像が残っていないため、数値や改善幅は確定できない。元ログの所在と値の対応付けは未解決である。別条件の過去記録には初回RAW open約2秒、初回Region Plan約660ms、同一Documentの再Plan約0.25msがあるが、これらを今回のフィルムストリップ切替のPreview計測値として扱わない。詳細は [LightCraft更新ガイド](UPDATE_GUIDE.md) と [Region Plan計測](REGION_C3B_PLAN_TIMING.md) を参照する。

## 現行ライフサイクル

BackendのWorkspaceは単一の公開Documentと、そのWorkspace専用のRawSourceCacheを所有する。LightCraftRawSessionはNativeプロセスのgenerationに紐づく写真snapshotとResidentのPhotoIdを管理する。RawSourceCacheの完成コピーはNativeが参照する期間を通じて保持する。

通常の写真切替ではFrontendが入力を停止し、Native readbackとRecipe／Historyの保存を確定してから移動する。Asset単位の `useRawDocument` は旧Workspaceを解放し、新WorkspaceとDocumentを開く。現行Backendでは `DELETE /documents/{handle}` と `DELETE /workspaces/{id}` が同じ `_release()` に入り、History checkpointを確認してDocumentを失効させる。その後、画像応答の所有期間を待ち、`reset_session(restore_active=False)` により旧Nativeプロセスを回収して新generationを起動し、RawSourceCacheを閉じる。通常切替で再生成される原因はこの寿命の結合である。

Preview／RegionはNative処理後にBackendのownerやrevisionを再確認する。送信済み操作はHTTP待機側の取消だけでは終了せず、画像応答のleaseはASGI送信完了まで所有される。保存未確定の場合は旧ownerを保持し、確認できない状態を保存成功として扱わない。明示Discardと通常Releaseは別の終了経路を持つ。

## P1-1の完了記録

Commit `3edfc505` でRawSourceCacheは同一Workspace内のAssetごとの完成コピーを保持し、パスとファイル情報のfingerprintを照合して再利用する。コピーはWorkspaceの回収まで保持する。Native側は写真ごとのImport直後の既定設定を保持し、Residentを再選択した際にも既定値のfingerprintを編集後の値で置き換えない。

Document OpenはSQLiteのRecipeとHistoryのidentity・revisionを照合し、保存済みRecipeを復元する。Recipeがない場合とエンジン非互換の回復経路では、必要に応じてImport既定設定へ戻す。Native Session内のA→B→AではAを再Importせず、tokenを更新する。原本コピーが変化した場合や復元に失敗した場合はDocumentを公開しない。Backend focused testsは250件成功した。これらは自動テストの結果であり、通常の画面切替では現時点でもWorkspaceが解放される。

## P1-2の設計

以下はP1-2で採用する契約であり、現行コードの動作ではない。

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

基準はmain `7bb85c81c0b3fd8c496977f2341e428fa98848af`。P1-1とP1-2A〜Dは実装済みであり、以下のFrontend変更は設計である。

### 現行の所有関係

`App.tsx` の `/anshitsu/:assetId` は同じ `AnshitsuPage` を描画する。`AnshitsuPage` は詳細情報が現在のAssetに一致し、現像方針がLightCraftのとき `useRawDocument(assetId)` を有効にする。`useRawDocument.ts` の `[assetId]` effectはWorkspace ID、Document、`RawControls`、`RawRecipeSave`、Preview／Region、heartbeatを所有し、Asset変更や `activeDetail` が一時的に空になるとcleanupで保存後のWorkspace Releaseを始める。新effectのOpenはmodule内の `ownership` queueと `pointColorTermination` を待つ。

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

通常の切替、Filmstrip除外とUndo、ブラウザ履歴によるAsset route変更は同じ所有queueのDocument交代を通す。画面に接続する `switchingRef`／`switching` は保存から新DocumentのOpen結果確定まで維持し、連続クリックやショートカットは既存Filmstripのdisabledとガードで拒否する。現在の `activateAsset()` はroute移動直後にガードを解除するため、Open完了・失敗の通知に合わせて解除する。予期しないunmountやroute変更も旧ownerの保存／Close完了を待ち、古いOpen結果を採用しない。

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

## P2以降

P2ではResident上限とSession再生成の頻度を見直し、Nativeカタログ、Undo、pending log、原本コピー、メモリ使用量の実測を踏まえて回収方針を決める。必要に応じてPreview再利用を検討する。初回読込みの高速化、先読み、暫定表示、サムネイル再利用は優先度を下げ、別工程で扱う。
