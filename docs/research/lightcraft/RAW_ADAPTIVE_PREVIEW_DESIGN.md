# RAW適応型プレビュー R1：接続調査・実装設計

調査日：2026-10-24（Asia/Tokyo）。**R1は調査・設計・文書化のみ。以下の設計提案は未実装で、R2以降の開始や性能仕様の確定を意味しない。**

## 1. 基準・目的・確定要件

開始時：`I:\code\genzoroom`、branch `feature/lightcraft-integration`、HEAD `f511dfc2775675cb350e0ee66a0b2f7ce0c44840`、作業ツリーclean。LightCraft（以下LC）は管理manifestのv0.10.0／`a2a41383c4fd62fa85a46ccd00998639221f2d3c`、SQLite schema v8、JPEG Recipe v18を維持する。実binaryの起動・receipt再検査は今回行っていない。

本書は、**確認済み事実**（ローカルコードまたは既存調査に根拠があるもの）、**提案**（今後実装・確認する契約）、**未検証／未決定**を区別する。関数名は上記HEAD基準。LC静的解析の再実施ではなく、[RAW_RENDER_RESOLUTION_RESEARCH.md](RAW_RENDER_RESOLUTION_RESEARCH.md)（特に§12〜15）の結果をGenzoRoomへ接続する設計である。

必須参照：

- [PHASE1C_DESIGN.md](PHASE1C_DESIGN.md)：初期案よりC4-B〜Fの実装・完了記録を優先。
- [PHASE1C_C4_NATIVE_FEATURES.md](PHASE1C_C4_NATIVE_FEATURES.md)：native機能の責任分界。C4-D補記を含む。
- [UPDATE_GUIDE.md](UPDATE_GUIDE.md)、[architecture.md](../../architecture.md)、[AGENTS.md](../../../AGENTS.md)。

依頼から確定している要件：

| 項目 | 要件 |
|---|---|
| 品質 | スライダー操作中Draft、確定後Full。単発操作・Reset・Undo/Redo・History jump後はFull。LCの`RenderJob::draft()`を用い、低解像度Fullで代替しない |
| 独立した表示属性 | quality、要求解像度、whole/regionを独立させる。表示属性だけでRecipe／History／SQLite／settings fingerprintを更新しない |
| 解像度 | 中央Viewerの表示領域、DPR、現像後geometry、Fit/Zoom/Pan、native解像度、時間・メモリ・転送予算から選ぶ。1024／1280／4096pxは製品固定解像度ではない |
| 描画方式 | Draft whole、Full whole、Draft region、Full regionの全4組を実装対象とする。Fitは表示に必要な全体描画、拡大時はコストと必要精細度からregionを選ぶ |
| 高画素 | Pentax等の長辺4096px超を含め、等倍で原本相当の細部を確認する。4096画像の拡大だけで受入済みにしない |
| UI | JPEGの操作体系を維持。RAW専用Preview/Original・手動Draft/Fullボタンは追加しない。画像交換で不必要にFit/Zoom/Panをresetしない。Before/Afterを維持 |
| 保存 | C4のnative readback・確定revision、200操作History、saveId/CAS/receipt/同一再送、unknown・失敗、owner/generation、切替・終了保証を維持 |

対象外：現像アルゴリズム変更、LC version更新、SQLite／Recipe schema変更、RAW Export／Scope、新規Crop/Lens UI、native Historyへの移管、完全preemption、NAS配備。R1では製品コード・LCソース・patch・既存C4記録・README・CHANGELOGを変更しない。実機RAW操作・Immich書込み、build、テスト実行、ブラウザ確認も行わない。

## 2. 現行C4接続の確認済み事実

### 2.1 Viewer・JPEG分岐

根拠：[ImageViewer.tsx](../../../frontend/src/ImageViewer.tsx)、[viewerMath.ts](../../../frontend/src/viewerMath.ts)、[AnshitsuPage.tsx](../../../frontend/src/AnshitsuPage.tsx)。

- `ImageViewer.viewportRef`がtoolbarを除いた中央`.viewer-viewport`を所有する。`ResizeObserver(updateFit)`は`clientWidth/clientHeight`を使う。最大化・パネル開閉等による要素サイズ変化はFit計算に届くが、描画要求としてhookへ通知する経路はない。DPRはこの計算に含まれず、DPR専用listenerもない。
- `loadedImage.size`はRAW plain `<img>`の`naturalWidth/naturalHeight`、JPEGは`AdjustedImage.onLoad`から設定される。`calculateFitScale(container,image)`、`scale`、`pan`、`fitMode`、`previousTransform`をViewerが所有し、CSS widthは`imageSize.x * scale`。`setActualSize()`のscale=1は現在PNGの1 pixel=1 CSS pixelで、RAW原本の物理pixel等倍ではない。
- `imageIdentity = documentKey ?? source identity`。同identityのURL更新では非Fitのscale/panを保持するが、PNG寸法が変われば見かけの表示幅が変わる。RAW寸法変更時の`useLayoutEffect`はpan clampであり、この尺度問題を解消しない。
- `AnshitsuPage`は`key={assetId}`、RAW `documentKey=assetId:generation:documentToken`を渡す。RAWはnative PNG＋`previewPixels`、JPEGは`editable`に応じた`editSource/recipe`による`AdjustedImage`。`jpegOriginal.status/showingOriginal/toggle`が既存Original UIを制御する。RAWの品質／解像度をこのJPEG切替へ混入させない。
- 比較は現状、同一imgのsrcをBeforeへ切り替える構造。Backslash、一時保持／persistent選択、IME・入力・dialog/menu guard、Fit復帰、pointer中心zoomを共用できる。領域tileを置くlayerはまだない。

### 2.2 操作境界・表示・保存

根拠：[RawAdjustmentControls.tsx](../../../frontend/src/RawAdjustmentControls.tsx)、[AdjustmentSlider.tsx](../../../frontend/src/AdjustmentSlider.tsx)、[rawControls.ts](../../../frontend/src/rawControls.ts)、[rawRecipeSave.ts](../../../frontend/src/rawRecipeSave.ts)、[useRawDocument.ts](../../../frontend/src/useRawDocument.ts)。

| 経路 | 現行の事実／再利用と不足 |
|---|---|
| 開始・変更・終了 | RAW panelは`onBegin/onChange/onCommit`を`beginControls/changeControls/flushControls`へ接続し、`RawRecipeSave.begin/change/end`が所有する。新たなDOM event体系は不要 |
| pointer | range開始、windowのpointerup/pointercancelで`finishPointer`。component unmountもcommitする。終了callbackには旧documentを触らないhookの`callbackEditor`検査がある |
| 数値 | focusだけで開始せず、最初の変更で`beginNumberEdit`。Enter/blurでcommit、Escapeは開始値へ戻してcommit。空／非finiteの入力は確定時に開始値等へ戻す |
| keyboard/wheel | begin/changeを送り、500ms静止で`commitAfterInactivity`。登録されたfocus移動による確定もある。これは現在の操作集約境界で、将来のFull用に別のpointer-only判定を追加しない |
| native ACK | `RawControls.flush`は150ms debounce・最新未送信patchを集約し、`setRawControls`のreadback済みsettingsを`confirmed`にする。native revisionとSQLite recipeRevisionは別 |
| 表示待ち | pendingが空になると同じflush内で`await options.preview`。`busy`はその後に解除。`useRawDocument.displayPreview`はHTTP PNG取得→decode→`readRawDocument`再確認→URL公開まで待つ |
| queue | module-level `ownership/enqueue`はmutation、save、release/openを直列化する。`RawControls.settle`は同queueのbarrier。`RawRecipeSave.save`はflushしてからbarrierを置き、queue内でsettleを待つdeadlockを避ける |
| 終了の意味 | `end`は保存を開始するがgestureはACKまで残る。`gesturing`はoperation/paused/movingも考慮するため、単純にこのgetterをDraft判定に使えない |
| 単発／履歴 | `operate/move/sendMoveIntent/sendHistory`がgesture commit→native操作／restore→DB ACK確認を実行する。`sendHistory`はmoving操作後に`await controls.refreshPreview()`し、operation/movingの解除も表示待ちに連動する |
| 再生成／離脱 | `restart`と`prepareSave`はreadback/保存を確定してrelease/open。`dispose`は送信済み操作を旧ownerが回収し、未確認dirty状態ではreleaseを抑止。単なるfetch abortで所有権は消えない |

同revisionで品質だけ変える契機はない。pending空の`flush()`は何もしないため、Draft→Fullは表示専用intentの入口が必要。画像失敗でもreadback済み編集の保存は可能という既存意図は`sendHistory`のコメントにあるが、現在はqueue/busyのため画像完了を待ちやすい。

### 2.3 Backend・MCP・安全境界

根拠：[windows_raw_api.py](../../../backend/windows_raw_api.py) `RawPreviewApi`、[lightcraft_raw.py](../../../backend/lightcraft_raw.py) `LightCraftRawSession`、[lightcraft_runtime.py](../../../backend/lightcraft_runtime.py) `LightCraftManager`、[lightcraft_mcp.py](../../../backend/lightcraft_mcp.py) `LightCraftMCP`、[raw_source.py](../../../backend/raw_source.py) `RawSourceCache`。

```text
RAW UI → RawControls / RawRecipeSave → useRawDocument ownership queue
  → rawApi.rawPreview → RawPreviewApi._preview (HTTP admission lock)
  → request_preview → _previews (adapter native lock)
  → manager._raw_preview → MCP.request (transport lock)
  → render_preview → render_photo → ui.render → synchronous Headless.render
  → PNG tempfile → Base64 + metadata → PNG検証 → HTTP PNG → decode → Viewer
```

- HTTP requestはworkspace/generation/documentToken/revision/serial/optional kindのみ。quality・size・regionは渡せない。`_preview_response`はowner、kind、revision／Before keyを再確認する。
- `_execute`とAfter `_preview`は同じ`_lock`を保持し、Afterはticket完了まで解放しない。optional Beforeはticket作成後にHTTP lockを解放し、応答時に再取得する。`endpoint`はaccepted taskをshieldしHTTP切断後も所有、task総数は現行2件まで。
- adapter `request_preview`はAfter pending 1件をlatest-winsにし、Beforeは別pending/sequence/cache。`_previews`はAfter優先。`_lock`をMCP render、PNG検証workerの回収、After `develop.get` readbackまで保持する。`_mutate/_submit`も同lockを使う。
- After readbackでsettings差があれば`_commit`してrevisionを更新し、元ticketはstaleとなる。renderを無条件read-onlyと仮定してこの確認を削除できない。
- `MCP.request`はpipe送信〜応答のlockを持つ。LC headlessも同期処理でdesktop JobPoolを通らない（既存調査§12.3）。送信済みFull中は次mutationや保存用native確認を追い越せない。timeout/cancelが送信後ならtransport abort／Session喪失になり得る。
- `_validate_png`はBase64、metadata strict keys、kind／Before fingerprint、寸法、pixel数、PNG CRC/IEND、Pillow verify/loadを検証。metadata追加は現在のstrict whitelistと同時変更が必要。`_image`はtimeout後もPillow workerをjoinして次画像と重複させない。
- `_raw_before_supported`は世代単位でboolean schemaを確認。品質／region capabilityは未提供。GPU現像とCPU fallbackはLCに任せる。GPU利用可能の情報だけで個別jobのGPU成功を証明できない。

### 2.4 Beforeと保存の不変条件

- `before_key`はsource内容/file identity、document/generation、engine tuple、native import fingerprint、process、crop/orientation、maxSideをhashする。After露光・WB・lensをBeforeへコピーしない。`_before_cache`はPNG1件。
- HTTPの`before_key(handle)`とFrontend documentのbeforeKeyは既定サイズ前提。`useRawDocument.beforeSizeMatches`はBefore/After実寸完全一致を要求する。任意サイズ／tileでは両方の契約を置換する必要がある。
- 保存は`RawPreviewApi._history`のreadback/applying/save/complete状態、`_history_verify/_confirmed`、`raw_recipe_store`のtransaction/CAS/receiptを経由する。initialize/commitはnative完全readback、moveはsnapshot restore/readback、operateはnative操作/readbackが必要。画像取得はDB writerの成功条件ではない。
- replayのimmutable ackとcurrent metadataは別。`RawRecipeSave.sendHistory`は現在owner/revision/fingerprint/cursor/recipeRevision/ack/saveId/nativeState/nativeMatchesRecipe/historyPendingを照合し、unknownは同一requestを保持する。これを表示schedulerの成功／失敗で変更しない。
- schema v8、History最大200、JPEG Recipe v18、native試行soft 200/hard 256を維持する。表示更新をmutation試行・History件数に加算しない。

## 3. LCとの責任分界と管理patch（提案）

| 所有者 | 責務 |
|---|---|
| GenzoRoom Viewer | CSS表示rect、DPR、Fit/Zoom/Pan、可視範囲、比較layer/clip。JPEGの既存尺度は維持 |
| Frontend表示scheduler | 操作中／終了意思、ACK済みrevisionへのintent束縛、未送信集約、view世代、結果採否・URL寿命。永続データは所有しない |
| 既存保存coordinator | mutation/gesture、History、saveId/receipt、離脱・再生成の整合。表示完了を保存成功条件にしない |
| Backend owner/arbiter | native操作直列化、送信前優先順位、immutable ticket、owner/generation確認、予算とpayload検証、送信済み処理・一時fileの回収 |
| LC Engine/pipeline | `render_job/.draft/run/accept`、`region_job/region_job_before`、実geometry、source level、空間効果、GPU/CPU fallback。GenzoRoomで現像式を複製しない |
| LC MCP | 型付き引数・capability・実適用metadata、boundedな画像搬出。egui Viewer全体をheadlessへ移植しない |

LCのDraftはquality変更であり解像度変更ではない。Full source選択・原寸RAW decodeはDraft／regionでも発生し得る。StageCache継続は有効な追加候補だが、最小品質公開だけではdesktopの全最適化は得られない。LC UI `region::plan/window_for`の丸め・margin・size holdは候補であり、egui依存のplannerをそのままBackendへimportしない。必要ならUI非依存helper化を別の小変更として評価する。

既存[0001-native-before.patch](../../../native/lightcraft/patches/0001-native-before.patch)は維持する。品質のschema／引数転送は`tools.rs::helper_tools/call_tool/render_photo`、実行は`headless.rs::Headless::render/Backend::call("ui.render")`のBefore追加と同じ境界へ統合する案を第一候補とする。regionも同じkind/quality/geometry/transport共通処理を使う。別patchなら順序依存をmanifestへ明示し、部分／重複適用を拒否する。patch分割方法・tool名は未決定。

[manifest.json](../../../native/lightcraft/manifest.json)の固定commit・patch digest、[build.py](../../../native/lightcraft/build.py)の`prepare/probe/receipt`を更新対象に含める。将来の実装では省略Full／既存Before互換、4組のschema・実quality・実寸・座標・kindを**実binary**でprobeし、その後にSHA-256 receiptを生成する。versionやschemaだけでDraft／region成功としない。R1ではこれらを編集・実行しない。

## 4. 描画要求・応答契約（提案、wire名は未確定）

### 4.1 共通identity・quality

Frontend→HTTPの表示intentは、既存opaque workspace/handle/generation/documentToken、**native ACK済みrevision**、renderSerialに加え、quality=`draft|full`、mode=`whole|region`、viewGeneration、geometry identity、寸法／windowを持つ。settings変更が未ACKなら最新intentだけ保持し、架空のrevisionへ送らない。native PhotoId・path・完全settingsはFrontendに公開しない。

Backendは送信時のowner、revision、settings fingerprint、geometry、quality/mode/size/window、kindとBefore基準をimmutable ticketへ記録する。MCPにはphoto idと必要な描画引数だけ渡し、revision等のGenzoRoom独自identityはBackendが束縛する。LCから受けたid/実quality/kind/geometry/寸法を検証してから、HTTPへopaque identityと実適用metadataを返す。HTTP metadataをheadersに載せるか小さなmanifestとして分離するかは、region項目数と転送方式で決定する。

- quality省略は従来Full。未知文字列、null、boolean等を明示拒否。`RenderJob::draft()`を実行した結果だけDraftと返し、qualityを黙って無視しない。
- 同revisionのDraft→FullはrenderSerialを進めて再要求する。Recipe/saveId/revisionを品質のためだけに作り直さない。
- capabilityはgenerationごとにquality enum、whole/region、Before対応、geometry/transport契約version、資源上限を検証・広告する案。旧binaryは従来Full wholeの限定動作として明示し、適応機能対応済みと偽らない。Beforeのみ非対応の場合のAfter継続は維持する。
- 応答の品質・座標等が要求と食い違う場合はstale／invalidとして拒否。単なる古い正常結果とtransport破損を区別する。204 SUPERSEDEDをFrontendで専用の非エラー結果にする（現在`rawPreview.check`は200のみ受理）。

### 4.2 whole・region

| mode | 入力 | 実行と返却 |
|---|---|---|
| whole | quality/kind＋出力boxまたはmaxSide。geometry identity | `render_job(id,w,h,before,true)`、Draft時`.draft()`。native frame寸法、実出力寸法、geometry identityを返す |
| region | quality/kind＋仮想full frame box、margin込みwindow、geometry identity | `region_job`または`region_job_before`、Draft時`.draft()`。実際にfitしたfullWidth/fullHeight、実window x/y/w/h、tile実寸、native frame・geometryを返す |

windowは未回転sensor座標や単純cropではなく、現像後full frame内のpixel座標。要求boxがaspect fitされるため、要求値をそのまま返却座標とみなさない。実full frameとwindowから配置する。整数／finite／正値、加算・乗算overflow、windowのframe内収容、仮想frame sideとtile side/pixelsの別上限をMCP・Backend両方で検証する。範囲外／不正値を黙って別の巨大要求へclampしない。

native geometryはsensor公称幅・高さだけで推定しない。既存調査§13.1の`Frame::with_lens`／実現像`frame_for`相当の設定・sourceを使い、crop/orientation/straighten/flip、lensを含む実frameをLCから取得する。`native_output_size`だけで埋込lens等を含む実geometryを証明できない。geometry identityは座標変換条件を識別し、単なるPNG width/height一致を代用しない。geometry取得用queryか最初のrender metadataか、source読込のcold costを含めて工程Aで決める。

region拒否（遠距離spot/Auto Mask read等）には構造化した理由を返す。予算内wholeへfallback、または既存wholeを保ち精細化を保留する。巨大原寸wholeへの無条件fallbackは禁止。最終受入は4096超の細部を必要領域で取得できることとし、fallbackのみでregion対応を完了にしない。

## 5. Viewerの論理座標・表示尺度（提案）

RAW専用frame descriptorを既存Viewerへoptionalに渡す最小変更を候補とする。JPEGは従来のnatural寸法・scale=1の意味を維持し、共通`calculateFitScale/zoomAroundPoint`と入力guardを再利用する。

- 論理frame `N=(Nw,Nh)`：LCが保証した現像後native pixel寸法。bitmap寸法`B`とは別。wholeやtileのonLoadで`N`を上書きしない。
- viewport `V=(Vw,Vh)`：`viewportRef`実領域のCSS pixels。DPR `d`：その時点の`window.devicePixelRatio`。画像の論理点`p`から画面点は `V/2 + pan + (p-N/2)*s`、`s`はCSS pixels/native pixel。
- Fitは`sFit=min(Vw/Nw,Vh/Nh)`。物理等倍は`s=1/d`。倍率表示を物理倍率`z=s*d`（等倍100%）へ揃える案とする。zoom操作は`z`へ既存倍率制限を適用してから`s`へ変換し、Fitは別計算とする。既存MIN_ZOOMを`s`へ直接適用して高画素Fitを切り詰めない。
- whole bitmapは論理frame全体`N*s`へ配置。仮想full frame `F`内のtile window `W`は、論理rect `(W.x*Nw/Fw, W.y*Nh/Fh, W.w*Nw/Fw, W.h*Nh/Fh)`へ置き、viewportと比較paneでclipする。tile天然寸法を全体画像寸法として使わない。
- whole要求の基礎寸法は、表示画像rect `R=N*s`に対する`min(R*d,N)`。丸めと予算をその後に適用する。Fitは表示面積、拡大時はwholeの必要pixelsと可視windowのcostを比較する。DPRの二重乗算を避ける。
- quality/bitmap size/whole→regionの交換は同geometryならs/pan/fitMode/previousTransformを保持する。高精細画像の到着をdocument変更にしない。
- geometryが変わった場合、Fitは再fit、Zoomは中心／pointer anchorを新frameへ対応づけpanをclampする案。crop/rotation/lensを跨ぐanchorの厳密な変換と、Session再生成時に同じ写真の視点を復元する範囲は未決定。いずれも旧geometry tileは即時非表示にし、新ownerの結果だけ受理する。

`ResizeObserver`からVを通知し、左右panel幅変更／resize／最大化を再計画する。DPRは`matchMedia(resolution)`再登録等で監視し、resizeでも再読込する案。DPR変更時、非Fitは同じ物理倍率zと中心anchorを維持する案を候補とするが、CSS見かけ寸法保持との選択はWindows複数monitor実測で確定する。DPR変更通知のみで新renderが大量発生しないよう丸め・hysteresis・gesture size holdを評価する。通知方式や遅延値をR1で固定しない。

JPEG Original切替、Filmstripの写真切替、Backslash比較の既存意味を維持する。RAW frame descriptorをJPEGに残さず、asset切替時は旧tile/URLを同期的に隠す。`key={assetId}`は継続利用できる。

## 6. 表示scheduler・所有権と状態遷移（提案）

### 6.1 状態の所有者・不変条件

| 状態 | 管理責任／更新条件／不変条件 |
|---|---|
| interactionId、active/ended、finalTarget | hook表示coordinator。既存begin/change/commit通知から更新。Historyのgesture存続とは別。終了時点の最新値がACKされるまでFullは送らない |
| confirmed native revision/settings identity | 既存RawControls＋Backend。readbackだけが更新する。表示要求はこのsnapshotを参照し、PNG成功は更新根拠にしない |
| viewGeneration/geometry identity | Viewer計測・Backend geometry応答。viewport/DPR/zoom/pan/geometry変更でintent更新。旧tile採否を判定する |
| latest unsent After intent | 表示scheduler。新編集、終了、view更新で置換。snapshotを無制限queueへ積まない |
| dispatched ticket | Backend native owner。送信前にidentityを再確認し、送信後はresponse/失敗を必ず回収する。UIの関心消失でnative taskをcancelしない |
| display candidate/accepted frame | hook。decode前後のowner/revision/view/quality検証。URLはcandidate失敗・置換・切替・再生成・離脱で解放 |
| Before pending/cache | Backendとhookの専用slot。同key集約、Afterをsupersedeしない。size/quality/windowもkeyに含む |
| save fence | 既存RawRecipeSave。mutation/readback/DB ack/unknown解決まで。表示candidateの成否を含めない |

### 6.2 遷移

```text
begin/change → 未送信Full失効 → 最新値のnative ACK → Draft intent
end          → 終了意思＋最終変更をflush → 最終ACK → Full intent
Reset/move   → 旧intent失効 → 既存操作・保存ACK検証 → Full intent
view変更     → 同revisionでsize/windowを再計画（操作中Draft、それ以外Full）
intent       → coalesced → admitted → sent → collected → validated → decoded → accepted
owner失効    → unsent破棄 / sentは旧ownerがcollect / candidateと表示cache解放
```

単発keyboard/wheelも現在の操作開始〜確定境界内ではDraft、静止確定でFull。Reset等の非連続操作には不要なDraftを挟まない。数値Escapeで元値へ戻るno-opでも、表示がDraftならFullへ戻すがHistoryを追加しない。

Full到着後、同じ表示targetへの遅いDraftで上書きしない。新編集が始まったら旧Fullはdiscardし、新ACKのDraftを優先する。pan/zoomの旧tileを現在の座標として再利用しない。同geometry・同revision・同qualityでcoverageが足りるcacheのみ再利用可能とする。連続操作で中間結果を採用する緩和は初期実装の前提とせず、厳格latest採用による表示停止が実測で問題になった場合だけ別途設計する。

## 7. 保存待機を分離する境界（提案・重点）

Frontendの`await preview`を外すだけでは、HTTP・adapter・MCPの直列化が残り、所有権も不明確になる。以下を一体で変更・試験する。

| 待機対象 | 保存成功に必要か | 分離後の扱い |
|---|---|---|
| 未送信Draft/Full、Before | 不要 | mutation/保存/履歴移動/離脱が先。集約・破棄できる |
| 送信済みrender | 計算自体は保存条件ではないがnative stream回収は必須 | native ownerが完了まで保持。同期MCPでは後続readbackが待つ限界が残る |
| mutation ACK・完全readback、restore検証 | 必須 | 既存操作fenceを維持。renderが返っただけで代用しない |
| render後のAfter settings確認 | 現行のnative整合保護 | native owner内で維持し、差分はrevision更新・stale化として扱う。PNG検証後である必要性を再評価 |
| SQLite CAS/transaction/receipt・current照合 | 必須 | saveId/body再送・unknown/failed・generation検証を維持 |
| PNG検証・HTTP body・decode・DOM表示 | 不要 | 表示ownerのfence。saveや次mutationのbusy/lockedと分離。ただしvalidation worker/fileの寿命を回収する |

1. **Frontend**：`RawControls`のbusy/unsettledをmutation/readbackに限定し、ACK後は表示schedulerへintentを渡す。`settle/RawRecipeSave.save`はmutation queueだけを待つ。`sendHistory`の`refreshPreview`も表示完了待ちからintent発行へ変える。表示失敗は専用stateへ出し、readback済み編集を未確認扱いに戻さない。保存errorを表示errorで消さない。
2. **HTTP**：Afterもticket作成時だけadmission lockを取り、待機中は解放する候補。旧C4-DのAfter cleanup barrierを削除するだけでは回帰するため、request owner snapshot＋応答時再検証、accepted native operation registry、release/close時のdrainを先に用意する。`_tasks`現行2枠を描画で埋めてmutation/保存を拒否しないよう、制御受付枠とbounded表示枠を分ける案を同時に検討する。
3. **adapter/native**：送信前のmutation/save fenceを未送信renderより優先させる共通arbiterを設ける候補。別々のqueueが同じlockへ先着するだけでは優先保証にならない。render実行→native整合readback→immutable画像・metadata確保までをnative占有区間とし、その後のPNG検証を切り離す。readback順を変える場合、renderがsettingsを変える既存経路・source acceptの整合をnative/fake双方で検証する。検証中に編集が進んでも、その結果を古いticketへ束縛したまま採否判定する。
4. **回収**：現行`_image`のworker join保証は残し、画像validationはboundedにする。native lock解放後に次renderを開始してPNG buffersを無制限に重ねない。旧owner registryは送信済みnative／validation／file読取をdrainしてからreleaseし、新generationへ移さない。decodeはnative資源を必要としないため表示候補を捨ててよい。

制御優先でBeforeが遅れることは許容するが、操作停止後の最終Fullがいつまでも発行されない状態は不可。arbiterの具体実装（既存worker拡張か単一dispatch層か）は工程Aで決める。Frontend・HTTP・adapterに独立したnative実行ownerを増やさない。

**残る制約**：一度送ったFull中はnative readbackを含む保存が待つ。完全なpreemption、別Session、不変settings job worker、協調cancelは今回の必須条件ではない。HTTP abortはwaiterの離脱、transport abortはSession失敗であり、同じcancelとして扱わない。実行中Fullの遅さはサイズ／region／予算で抑え、操作のたびにprocessをkillしない。

## 8. Before/After・全体と領域の合成（提案）

import基準Beforeとkind/fingerprintの証明は維持する。Recipe/History baselineや現在AfterをBeforeへコピーしない。次の4組はBefore/After両方のnative jobに適用する。

| 品質 | whole | region |
|---|---|---|
| Draft | 同じ表示targetのDraft比較pair | 同じ仮想frame／window targetのDraft比較pair |
| Full | 同じ表示targetのFull比較pair | 同じ仮想frame／window targetのFull比較pair |

**比較品質案**：比較可能と示す画像pairは同qualityを基本とする。After Draft対Before Fullを無表示で混ぜない。片側待機時は既存Afterを維持し、比較準備中／失敗を表示する既存方針を使う。古い比較pairを維持する案との選択は待ち時間測定で決めるが、過去revisionを最新比較として示さない。手動品質ボタンは作らない。

wholeは背景layer、regionは同じ論理frame内の詳細layerとし、Before/Afterをそれぞれwhole＋tileのまとまりとして切り替える。将来wipeを追加するための新UIは本作業に含めず、既存切替でもlayer全体を同じclip/transformに乗せる。tileだけBeforeへ切り替えてAfter背景を残し、混在を比較画像として見せない。同一sideでもrevision/geometry/qualityが違うwholeとtileの混在は避ける。詳細が揃わない領域は明示的な低精細fallbackまたはwhole比較へ戻す。

regionは可視矩形をframeへ逆変換し、margin拡張・snap・clampしたwindowを要求する。返った実windowで配置し、viewport／比較領域／frame境界でclipする。marginは空間処理のcontextとpan先読みの目的を分ける。LCの内部contextを独自cropで代替しない。最大spanにより1 tileが可視領域を覆えない場合の複数tile化かcoverage制限は未決定で、覆えていない部分を等倍精細として報告しない。

**geometryの注意**：現行Beforeはcrop/orientationのみAfterに揃え、lens/opticsはimport基準のまま。両側の実frame寸法／変換が一致する保証はない。sideごとのnative frame/geometry identityと、比較用の共通表示座標へのmappingを返す契約が必要である。geometry identityが同じなら§5の直接配置、異なるならLCが示す有効なmappingまたは検証された共通正規化frameを使う案。単にBefore PNGをAfter tile寸法へstretchして整列済みとしない。厳密なscene対応とnative lens差を残した比較のどちらを求めるかは仕様判断として残す。mapping未確定のgeometryではtile比較を保留し検証可能なwhole比較を維持するが、全要件の完了にはこのケースの表示契約・受入が必要。

cache keyは、source/document/generation/engine契約、import/effective Before fingerprint、process、**sideの実geometry＋比較mapping identity**、quality、mode、実出力size、仮想full frame、windowを含む。Beforeの色調に関係しないAfter revisionはcache本体のkeyから外せるが、配信ticketは現在owner/viewへ再束縛して検証する。現行default maxSide前提のbeforeKeyを、基準identityとrender-specific keyに分ける案とし、HTTP応答も当該要求keyで照合する。

cacheはentry数とencoded/decoded bytesの両方で上限、LRU等で破棄、表示中pairを考慮しつつ旧候補を先に解放する。上限値・pinの扱いは測定で決める。pan/zoomでviewが変われば古いtileを非表示にし、正しいcoverageのcacheのみ再利用。crop/orientation/lens/mapping変更は旧tile全失効。写真切替／generation変更／離脱でBackend cache、Frontend Blob URL・decoded資源を破棄する。Before失敗はwarnとRetry対象に留め、正常なAfter編集・保存を止めない（transport喪失は全Session共通障害として別扱い）。

## 9. 容量・時間・メモリの予算

### 9.1 現行の安全制約（確認済み、将来値ではない）

| 層 | 現在の上限／根拠 |
|---|---|
| HTTP入力 | `windows_raw_api.MAX_JSON_BYTES` 4KiB。通常JSON応答も4KiB、History pageのみ16KiB |
| 描画side/pixels | adapter/frontendは長辺1024、pixels≤1024²。MCP helper上限4096、headless内部clamp16384は別の境界（既存調査§7/13） |
| 画像 | adapter/frontend PNG 5MiB。Base64文字数≤`4*ceil(MAX_IMAGE_BYTES/3)`、metadata≤16KiB |
| MCP | 通常line 1MiB、render_preview応答8MiB。runtime subprocess StreamReaderも8MiB。region tool追加時に応答limit分類も必要 |
| 時間 | adapter admission 5秒、preview 60秒、validation 10秒。Frontend preview 90秒、decode 10秒。送信後timeoutはSession喪失を起こし得る |
| engine | `app.memoryBudget {mb:1024}`。source/stage等のbudgetで、Python/WebView/全processのhard RSS上限ではない。GPU buffer上限はdevice別 |
| RAW source | `raw_source` 原本512MiB、cache 1GiB、空き予約1GiB。画像preview予算とは別。原本取得streamとcleanup ownerを維持 |

### 9.2 制約を緩和する場合の代替保証（提案）

数値は未決定。capabilitiesにboundedな最大side、pixels、tile pixels、仮想frame、encoded bytes、metadata、同時候補数／cache bytesを宣言し、各層が超過を拒否する。dimension検査をdecode前に行い、PNG content依存の圧縮後容量も別に制限する。上限の一つだけを無制限化しない。

- インラインPNG案では、`4*ceil(PNGbytes/3)+JSON/metadata overhead ≤ MCP line limit`を満たすbyte budgetを明示する。Base64、JSON文字列、PNG、Pillow load、HTTP buffer、Blob、decoded RGBA、texture、旧frame、Before、tileが重なるpeakを測る。RGBA8は概算4×pixels、RGB32fは12×pixelsだが、これをpeak RSSの実測値と混同しない。
- 全体nativeを予算内で返せるなら4096超wholeも許す設計。regionは仮想frameが4096超でもtile pixels/bytesは別にboundedとする。原寸source decode/保持/GPU uploadが残るため、regionだからメモリ問題が消えるとは保証しない。
- 画像転送の候補はbounded inline（小whole/tile）と、MCPが画像descriptorだけ返しBackendが所有一時fileからHTTP binary配信する方式。後者はBase64/line膨張を避けるがdecode・現像メモリは減らない。切替値や単一路線の採否は測定後に決定する。任意`path`付きexportをそのまま公開しない。
- file案では専用fixed-local temp root／generation directory、推測困難なopaque id、許可された相対basename、通常file・symlink/reparse/containment確認、byte/pixel/metadata検査、open/delete競合対策、読取所有権・disk quota・残容量・期限付き回収が必要。Frontendへpathを渡さず既存認証/Host/Origin/no-storeを維持する。
- 現行runtimeの`_raw_preview.finally`は正常MCP応答直後に`_remove_preview_files`を行う。file転送ではこの時点で消すと読めない。完了descriptor→所有権検証→open/readまたはstream完了→deleteへ移し、切断後はprocess reapとreader drain後に回収する。全directory掃除と配信中fileの競合を防ぐ。
- PNG/Pillow検証を省略せず、遅いworkerはjoinする。encode、validation、transfer、decodeに個別の測定とdeadlineを設ける。新しい値は実測前に確定せず、現在の上限を超えた場合はtyped budget failure／低精細fallbackにする。
- GPU不可／OOM／CPU fallback時も予算判定を再評価する。実GPU pathを応答で証明できるかは未検証。推定フラグを実行実績として記録しない。遅いjobに合わせた無制限timeout延長はしない。

ログは既存structured loggerを使い、render request/sequence、generation/revision、quality/mode、geometry opaque id、dims/window、pixels/bytes、phase別時間、coalesced/stale/fallback/errorCodeを選ぶ。正常要求詳細はdebug、重要lifecycleはinfo、回復可能fallback/Before失敗はwarn、必須処理の終端失敗はerror。ログ失敗は処理に影響させず、RAW／pixel／Base64／Recipe・History本文／token／path／full URLを記録しない。

## 10. 実装工程案・依存関係・受入条件

以下は候補工程の再編案。R番号・patch分割を確定せず、工程Aで境界が一体ならまとめる。品質・geometry・schedulerを別々に完成扱いにして危険な待機分離を後回しにしない。

### A. 最小契約と所有権の縦接続 → 最初の実機測定

- **対象／境界**：MCP qualityとnative frame metadata、Before patch互換、runtime capability、共通ticket identity、Frontend操作終了intent、§7の保存待機分離、RAW論理尺度の最小接続。wholeは現行安全範囲の任意サイズで開始する。測定準備であり1024固定製品仕様ではない。
- **依存**：R1。geometry query/readback順、arbiter、legacy binary限定動作を実装前に決定。
- **受入**：同寸法Draft→Fullを同revisionで取得し実quality検証。Reset/move後Full。表示だけでDB/History増分なし。PNG validation/decode停止中もnative ACK済み保存が完了でき、送信済みrenderは回収される。画像失敗を保存失敗へ誤伝播しない。JPEG操作回帰なし。
- **自動**：native enum/schema/省略Full/Before非転写/read-only、実binary probe/receipt。Backend fakeでrender処理・readback・validationを別gateにしてlock/admission/priority/release/cancelを検査。Frontend fakeで操作境界、同revision、遅いFull対新編集、unknown receipt保持、decode遅延、離脱と旧owner回収を検査。関連TS check/build、Backend関連検査、diff check。
- **Windows**：最初の性能測定を**Aの縦接続直後、適応閾値や大画像上限を決める前**に行う。CPU/GPU、cold/warm、同サイズDraft/Full、tone/NR等、encode/MCP/validation/HTTP/decode、操作終了→Full、新操作→ACK、保存readback待ち、RAM/VRAMを記録。初期安全範囲での値を高解像度へ比例外挿しない。
- **停止**：native品質を証明できない、geometryが実現像と一致しない、保存owner/receiptやcleanupが退行する場合は先へ進めない。Draft高速化率は未保証。

### B. 表示依存whole・転送予算の検証

- **対象／境界**：viewport/DPR/geometry/zoom計画、尺度保持、サイズ別Before key、strict metadata更新、広告上限、必要ならbounded file転送。LC helper4096制限緩和は代替予算と同時に扱う。
- **依存**：A測定結果。転送方式と予算の暫定測定範囲を先に合意する。
- **受入**：resize/最大化/左右panel/DPRで再計画。同geometryの異解像度で非Fit尺度・anchor保持、物理1:1。サイズの異なるwhole比較でも共通論理座標が正しく、JPEGは従来どおり。予算超過時にboundedに失敗・回復する。
- **自動**：`viewerMath/ImageViewer/useRawDocument/rawApi`の寸法独立、DPR、stale、URL回収、JPEG分岐。Backendのpixels/bytes/line整合、悪意あるmetadata/PNG、file案のpath/削除競合、Before key分離、save並行。変更境界のtype/build/static checks。
- **Windows**：複数monitor表示scale、page zoom、縦横RAW/crop/rotation、Pentax等4096超whole、圧縮しにくい画像、Before同時保持、CPU fallback。高精細wholeの時間・peak・bytesを測る。
- **停止**：上限を広げなければ動かないのに代替保証がない、1:1が拡大表示だけ、scale変更で視点が跳ぶ場合は不合格。wholeが予算外でも最終要件を縮小せずCへ反映する。

### C. Draft/Full region・Viewer合成・比較を一体化

- **対象／境界**：MCP region job公開、仮想frameとtile予算、margin/clip、whole＋tile、Before比較mapping、bounded cache、pan/zoom世代。全体／領域選択policyをA/B/C測定から決める。
- **依存**：Aのquality/owner/geometryとBの論理尺度・転送予算。Before/Afterで異なるgeometryの比較契約を解決する。
- **受入**：4組すべてのnative到達・実品質・座標証明、4096超原本相当の等倍細部、pan/zoom後の旧tile排除、境界の不自然な継ぎ目なし、Before失敗時After継続。region拒否時も無制限wholeを要求しない。coverage不足は明示する。
- **自動**：LC whole/window対応・crop/flip/rotation/lens・Draft/Full・Before基準、window拒否。Backend integer/overflow/frame-clamp/limit、cache evictionとAfter優先。Frontend layer位置/clip/side一致、quality pair、geometry切替、late tile/close、mixed Filmstrip。既存windowテストの再利用に加えMCP→HTTPの統合を検証する。
- **Windows**：同じ高画素素材でwhole対regionの精細さ、色、NR/sharpen/dehaze/lens/margin/境界、GPU/CPU、source decode/upload、連続pan/zoom＋slider、新編集対処理中Full、Before保持peakを比較。tile数・margin・切替閾値をここで調整する。
- **停止**：実frame mapping不明、quality偽装、tile縫い目、原寸sourceの予算超過、geometry非対応を隠した場合。必要な複数tileやnative helper切出しの規模が大きければ選択肢と影響を提示して工程を再計画する。

### D. 変更境界の横断受入・最終予算確定

- **対象／境界**：A〜Cのdiff/dependencies/failure pathsを監査し実測からpolicyを確定する。既存C4完了記録を書き換えず新機能の証拠を残す。
- **依存**：4組・尺度・保存分離の受入、Windows測定結果。
- **受入**：History 200件/枝切り/Undo/Redo/jump、200/256試行再生成、saveId/CAS/unknown retry、通常終了、RAW↔JPEG/Filmstrip、Before失敗、timeout/transport喪失と復旧で既存保証を維持。品質／view変更だけで永続値が変わらない。
- **自動**：下記既存回帰を中心に、変更した共通infraの影響に応じて拡張。full suiteが必要ならfocusedで不足する根拠を先に示す。build/type/static/diff確認、実binary capability/receipt最終照合。
- **Windows**：ユーザーによる長時間・複数scale・高画素・比較・保存失敗回復の受入。NAS/Firefoxや配布artifactは対象契約を別途明示し、Fake成功で実機成功としない。
- **停止**：未解決の保存整合問題、資源上限欠如、細部不足、主要な比較不整合。解決済み範囲の重複監査は行わない。

依存図：`R1 → A → 初回測定 → B → C → D`。regionのAPI fixtureやgeometry mapping調査はAの契約を共有できた段階でBと並行準備可能だが、性能policyの確定は測定後。regionをFull専用・任意の将来機能へ格下げしない。

### 既存回帰の再利用先（本文・テスト名を調査、今回は未実行）

- Frontend：`rawControls.test.ts`、`rawRecipeSave.test.ts`、`rawHistorySave.test.ts`、`useRawDocument.test.tsx`、`rawApi.test.ts`、`viewerMath.test.ts`、`ImageViewer.test.tsx`、`AnshitsuRawPreview.test.tsx`、`RawEditHistory.test.tsx`。既存の同一owner URL交換、比較中zoom/pan、JPEG分岐、lost save応答→同saveId再送、close/再生成・200操作等を再利用し、同じ目的のテストを重複しない。
- Backend：`test_raw_before.py`のcache/read-only/After優先/不正kind、`test_lightcraft_raw.py`、`test_windows_raw_api.py`、`test_raw_history_api.py`、`test_raw_history_store.py`、`test_raw_recipe_restore.py`、`test_raw_category_operations.py`、`test_raw_source.py`とruntime/MCP/patch管理の関連テスト。新しいlock解放・response drain・validation分離の競合を追加対象とする。
- native：既存調査にある`one_to_one_window_pixels_are_export_pixels`、`tests_window`とDraft stage-cache回帰、管理Before fixtureを利用し、MCP公開契約の回帰を追加する。CPU/GPU全設定の完全一致や実RAW品質はこれらの既存成功だけでは保証しない。

## 11. 実装前の判断・実測で決める項目

| 判断 | 選択肢・根拠／解決時点 |
|---|---|
| geometry metadata取得 | 専用queryか初回render付帯か。実frame/lens/sourceとの一致とcold読込costをAで確認。寸法だけの推定は不可 |
| native dispatch/readback | 既存worker拡張か共通arbiter。画像検証をlock外へ出す順序と、制御受付枠・cleanup drainをAで決定 |
| 比較geometry | native lens差を残した共通正規化frameかLC mappingによる対応か。色調比較の意味と細部座標の整合をC前に確定。After opticsをBeforeへ転写する解決は不可 |
| 比較待機 | 同quality pairが未完了の間、After＋待機表示か、明示した旧pair保持か。A/B測定から決定 |
| DPR時の視点 | 物理倍率と中心保持、またはCSS見かけ寸法保持。RAWの1:1定義を満たす範囲でB実機確認 |
| API形状・patch構成 | render_preview拡張＋region別toolか統一modeか、既存patch統合か順序付き追加か。旧Full/Beforeとconnect非対応明示、probe/receipt保守を基準にA/C前に決定 |
| 転送・資源値 | inline/file、whole/tile pixels、side、line/PNG/cache bytes、同時buffer、時間予算、CPU fallback時policy。A初測定→B/C高画素測定で段階決定 |
| whole/region選択 | viewport必要密度、全体cost、CPU/GPU実測、source/cache再利用から判断。LCの閾値・grid/marginを候補にするが固定転記しない |
| tile coverage | 1枚＋marginで足りないviewportを複数tileで覆うか、要求密度等を制限するか。原本相当細部の最終要件を満たすC測定で判断 |
| StageCache | 継続なしの最小公開と、Before/After/region別bounded cache。NR Draft効果とRAM/VRAMをA/Cで比較し必要性を判断 |

これらはR1で独断確定しない。性能値、固定プレビュー解像度、容量・timeoutの将来値、完全preemptionの達成は主張しない。領域出力でも原寸sourceのコストが残ることを実機予算に含める。

## 12. R1の検証・終了範囲

本書の根拠はローカル製品コード、既存調査・C4設計／architecture、管理patch/manifest/build scriptと既存テスト本文の静的確認。参照pathと関数名、要件と工程・受入の対応、文書差分の空白を確認する。build・テスト・実binary probe・実機RAW/GPU・ブラウザ動的確認・Immich書込みは実施しない。

変更対象はこの文書のみ。`git diff --check`と追加文書のstaged差分を確認後、この文書のみCommitし、指定された`origin/feature/lightcraft-integration`へPushして停止する。R2以降のコード実装には進まない。

## 13. A1確定契約（2026-10-24）

開始HEAD `944b0f4a3b1b63e189b588e021f36145f761f34e`、branch `feature/lightcraft-integration`、作業ツリーclean。**§1〜12はR1時点の記録として保持し、A2/A3の実装契約には本節を優先する。** A1も文書更新のみであり、以下の「確定」は実装・実機検証済みを意味しない。LC固定commit、SQLite v8、JPEG Recipe v18、既存C4完了記録は変更しない。

追加確認は既存owner・lock・strict metadataと、geometry/StageCache接続に不足した型・関数に限定した。LC参照sourceの`RenderJob/RenderResult/DecodedSource`、`pipeline::plan/Frame/StageCache`、eguiのstage計量を読んだが、checkoutのGit情報はsandboxから取得できず、固定HEAD・patch diffの再検証はしていない。LCの根拠は既存固定commit調査を主とし、以下の追加接続方法はA2で固定sourceに対して確認する。build・テスト・実機操作は未実施。

### 13.1 MCP品質・応答・互換性

**採用：既存`render_preview`を拡張する。** wholeを別toolへ移さず、工程Cでは`render_region`を追加し、以下の品質・frame・画像envelopeを共用する。A2/A3ではregionは非対応として広告・拒否し、4組対応の完了とはしない。

| `render_preview`引数 | A2契約 |
|---|---|
| `id`, `max_side`, `format`, `before` | 既存意味を維持。GenzoRoomはidを明示し、format=`png`のみ使用。`before`省略false、max_sideの既存default/clampと公開上限は維持。A3から送る値は事前に16〜1024の整数として検証する |
| `quality?` | enum `"draft" | "full"`、省略`full`。null/boolean/数値/大文字/未知文字列を拒否。schemaと実引数parser双方で検証 |
| `preview_contract?` | integer、対応値は`1`だけ。型違い・未知versionを拒否。追加metadataの明示opt-in。GenzoRoomは常に1を送る |
| `stage_cache?` | enum `"off" | "on"`、省略off。測定用native実行optionで、品質・Recipeではない。on時のbudget指定は§13.7 |
| `stage_cache_budget_bytes?` | on時のみ必須の正の整数。off時の指定は拒否。engine memory budgetを超える値・overflowを拒否。Frontendから任意値を転送しない |

`quality`、`preview_contract`、`stage_cache`のいずれかを明示した呼出しをadaptive契約1とする。qualityだけを指定した一般MCP clientにも実qualityを返す。すべて省略した旧呼出しはFull、旧metadata形状を維持する。これは旧GenzoRoom `_validate_png`が未知metadata keyを拒否するために必要な互換境界であり、無条件に追加fieldを返して旧adapterを壊さない。quality省略＋preview_contract=1の場合もmetadataで`full`を確認できる。

実行はBefore/Afterとも`Session::render_job(id,size,size,before,true)`、Draftなら`.draft()`、任意の`.with_stages(...)`、`run()`、`session.accept(&result)`。Fullは通常job。native interaction/history command、現像式、source選択を品質のために変更しない。`render_photo`共通helperにも同じoptional引数とparserを接続し、`call_tool`の引数抽出で落とさない。headless以外のbackendが契約を証明しない場合、明示quality要求を成功扱いしない。

成功は従来どおり`isError:false`、image content 1個＋JSON text metadata 1個、`structuredContent`なし。adaptive時のmetadataは既存`id/width/height/kind`とBefore追加fieldを保ち、次を加える（数値は型名を示し、解像度仕様ではない）。

```text
previewContract: 1
quality: "draft" | "full"             # 実行したjob.request.quality
mode: "whole"                        # Cでは"region"も許可
frame: {
  geometryId: <opaque lowercase hex64>,
  nativeWidth: <positive integer>, nativeHeight: <positive integer>,
  aspect: <finite positive number>,
  fullWidth: <positive integer>, fullHeight: <positive integer>,
  window: null                       # Cでは{x,y,width,height}
}
stageCache: {
  mode: "off" | "on", applied: <boolean>, reason: "none" | "budget",
  cpuBytes: <nonnegative integer>, gpuBytes: <nonnegative integer>,
  retainedBytes: <nonnegative integer>, budgetBytes: <nonnegative integer>
}
```

wholeでは`fullWidth/Height=width/height`、window=null。native寸法は表示bitmap寸法ではない。Beforeの既存`geometry:{crop,orientation}`、`beforeFingerprint/effectiveBeforeFingerprint`は削除・改名せず、追加の`frame`と区別する。hashは画像出自の署名ではない。diagnostic fieldを追加する場合も契約のallowlistを同時更新する。

エラーはMCP tool error（`isError:true`）、画像なし、固定JSON text `{"code":"…"}`とする。新契約のcodeは`preview_invalid_quality`、`preview_invalid_contract`、`preview_invalid_stage_cache`、`preview_unsupported`、`preview_geometry_unavailable`、`preview_geometry_mismatch`、`preview_budget_exceeded`、`preview_render_failed`。不正qualityはjob生成前に拒否する。既存photo/IO失敗等を無制限なupstream文言とともに返さない。汎用RPC／transport errorは既存経路を維持する。

GenzoRoomの`MCPToolError/call_tool_result`は、**このallowlistのcodeだけ**を新契約失敗から抽出できる最小拡張を行う。任意のtextをUI/logへ流さず、旧／不明errorは従来`lightcraft_tool_error`。HTTPは不正入力400 `raw_invalid_preview_request`、非対応503 `raw_preview_unsupported`、geometry未取得／取得失敗502 `raw_preview_geometry_unavailable`、正常stale/supersededは204、予算超過413 `raw_preview_budget_exceeded`、画像不正502 `raw_invalid_preview`へ写す。既存owner/revision conflictとtransport失敗のcode/意味は維持する。

capabilityはgenerationごとの`tools/list`でquality enum、preview_contract=1、Before boolean、cache引数schemaを検査し、実応答もpreviewContract/kind/quality/frameを検証する。schema単独を実行証拠にしない。旧binaryはadaptive=falseとして従来Full wholeを利用し、quality等の新引数を送らない。旧metadataからnative frameを作らず従来PNG尺度の限定動作とする。Before capabilityは独立に保持し、Before非対応だけではAfter編集を停止しない。新schemaを広告して不正metadataを返すbinaryは黙ってlegacyへ格下げしない。

**patch方針を確定**：A2は既存`0001-native-before.patch`にMCP拡張を統合し、名前は維持、manifestのpurpose/targets/digestとprobe/receipt契約を更新する。別の重複hunk patch列は作らない。既存Before機能・省略After互換fixtureを保持する。実binaryで省略Full、明示Draft/Full、Before両品質、metadata、cache off/onをprobeし、成功後だけreceiptへ`previewContract:1`を記録する。現行Before receiptだけで新契約対応と認定しない。これらはA2の変更でありA1では触らない。

### 13.2 Geometry取得方式と実装確認gate

**採用：render応答の`frame`に付帯し、専用geometry queryはA2/A3に追加しない。** queryはsourceのlazy loadとeffective settings解決を別途行う必要があり、query後のrenderとの対応付け・追加native往復が増える。render付帯なら同じjob snapshotとsourceを根拠にできる。初回Full wholeがbootstrapし、frame取得まではRAWの新しい論理尺度を未確定として扱う。操作ACKごとに別のgeometry queryを待たせない。

geometryの正本はLCが使用した実frame。A2のheadless helperは、jobのsourceを一度loadし、`DecodedSource.image_for(job.settings.denoise_amount())`、`info_or(job.info)`、`pipeline::plan`が解決するeffective settings／frameを取得する。renderにも同じdecoded sourceを`SourceRef::Loaded`として渡し、metadata取得のためにRAWを二重decodeしない。既存`run/accept`と同じsource cache挿入・As Shot学習を維持する。`Frame::new`、sensor公称値、PNG自然寸法からの単純倍率逆算で代替しない。

ここにはR1から具体化した**実装確認gate**がある。`Rendered`はimage/histogram/deepしか持たず、`RenderResult`も実frameを公開していない。さらに`pipeline::plan`はprofile/Uprightの解決、`frame_for`はlens/automatic CAを含む。したがってjob.settingsだけの`Frame::with_lens`を実frameと呼べない。

- 出力座標の根拠は上記実Planのframe、native寸法の根拠はLC importで確認されたEXIF-oriented original width/heightと、**同Planで解決したgeometry条件・decoded lens情報**によるnative座標のFrameとする。native frameの`native_size()`をLCの丸め規約（finite、正値、四捨五入）で整数化し、連続frame aspectを別に返す。Preview sourceのwidth/heightをnativeとせず、`native_long`だけから短辺を推測しない。
- geometryIdは契約version＋source内容identity＋native寸法＋effectiveなorientation/crop/flip/warp/lens/CAの座標変換記述から作るSHA-256 opaque値。quality、色調値、要求maxSide、region window、renderSerialは入力にしない。色調変更だけで無効化しない。source level依存の推定で**実際の変換が変わった場合**は新geometryとする。
- MCP helperから既存公開APIだけでnative座標への同じ変換を正確に取り出せるか、A2でfixture確認する。native dimensionsでのlens/warp再構成、Planとの一致、rounding、source学習の保存方法が確認対象。profile/Upright/CA推定を独自実装したり、Full sourceを無条件追加decodeして辻褄を合わせたりしない。
- 取り出せない場合は`preview_geometry_unavailable`として新契約を未達とし、**metadata観測用の最小accessor/sidecarをEngine/pipelineへ追加する案と影響範囲を報告してから再判断**する。現像アルゴリズム変更や未知geometryを推定値で成功にする契約は確定しない。このgateは保存整合性の未解決を隠すためのものではなく、現状に実frame getterがないという明示的なA2実装条件である。

GenzoRoomのnative revisionはLCへ新設しない。Backendがrender送信前に確定revision/settings snapshotへ束縛し、`run/accept`後の完全settings readbackを同じnative区間内で確認する。readbackが変化した場合は既存`_commit`に従ってrevisionを更新し、当該画像を旧revisionへ配信しない。204には固定値の`X-Raw-Superseded-Reason: revision | replaced | cancelled`を付け、A3はrevisionの場合だけ既存owner queueでsettings再同期を1回行い、現在revisionへの新intentを作る。replaced/cancelledは再同期せず最新slotの処理へ戻る。mutationや未知保存requestを勝手に再送せず、再同期でretryRequestや保存checkpointを上書きしない。繰返し不一致は表示errorとし無限再描画しない。

Beforeにも同じ取得方法を適用するが、settingsはnative import Before（現crop/orientation整列）である。Before/Afterで別geometryId・native寸法を返す。A2/A3では同geometryかつ同品質の比較pairを成立条件とし、不一致はAfter＋比較準備不可／Retry表示で保持し、画像stretchで整列済みとしない。R1§8の異geometryの比較mappingは工程C前の仕様判断として残す。これは4組・高画素・比較の最終要件を削るものではなく、A段階の明示的な制限である。

### 13.3 HTTP・render identityと採否

HTTP `/api/raw/documents/{handle}/preview`は既存owner fieldを維持し、adaptive時に次を受ける。stage cache設定は内部測定設定からruntimeが付与し、HTTPから指定させない。

```text
workspaceId, generation, documentToken, revision, serial, kind
quality: "draft" | "full"
mode: "whole"
maxSide: integer
viewGeneration: integer
geometryId: hex64 | null
```

serialは既存renderSerialとしてkind別に単調増加し、現在の31-bit検証を維持、使い切る前にdocumentを安全に再openする（wrapしない）。viewGenerationも非負safe integerで、viewport/DPR/zoom/pan/geometryの新targetに進める。新しい永続versionではない。geometryId=nullはそのkind/ownerで初回bootstrapまたはsettings変更後のgeometry未確認要求に限り、**座標を指定しないwhole**で使える。regionはnull不可。Backendはnullを送信時に実jobへ束縛し、応答で実geometryを確定する。

identityは`(workspace, handle, documentToken, generation, nativeRevision, kind, serial, quality, mode, requestedSize, expectedGeometry, viewGeneration)`。Backendのepoch/sequenceも引き続き検証する。MCPへGenzoRoomのopaque ownerやDB revisionは渡さない。工程CのregionはrequestedSizeを仮想fullWidth/fullHeight、windowへ拡張するだけで同じidentityを使う。windowは最終現像full frame内の整数pixel座標、返却実full frame/windowを正本としsensor座標へ変更しない。

HTTP応答は既存`X-Raw-*`owner/revision/serial/epoch/sequence/kindを維持し、`X-Raw-Quality/Mode/View-Generation`と`X-Raw-Frame`（§13.1のframeをASCII JSON化）を加える。frame metadataは既存16KiB以内、数値・field allowlist・PNG実寸との整合を検証する。BackendはMCP geometryIdにsource/document/generationを束縛したopaque geometryIdをHTTPへ返す。MCP内部source hash・native PhotoId・pathをFrontendへ渡さない。

採否はHTTP受付／native送信直前／native回収後／PNG検証後／decode後／URL公開直前で行う。

1. owner/generation/tokenと現在documentが一致し、native状態がsyncedであること。pending mutation／History未確定中のrenderは保留し、確定revisionを飛び越えない。
2. Afterは現在confirmed nativeRevision一致、kindごとの最新serial・viewGeneration・quality・mode・要求size/window・geometry一致。bootstrap nullだけは返却geometryを当該targetに採用できる。
3. 同revisionのDraft→Fullでもserialが異なるので別要求。qualityを除いたrevisionだけでdeduplicateしない。Full公開後に旧Draftが上書きすることはない。新begin/changeで旧Full/Draftの採用資格を即時失効させる。
4. Before cacheはAfter revisionを跨いで再利用できるが、現在ownerと基準key（import/process/実geometry）に合うこと。cache画像を現在ticket revision/serial/viewへ再束縛し、After pairとのgeometry/qualityも確認する。
5. 正常な旧結果は204／superseded扱い、表示error・save errorにしない。異常な応答の品質偽装、PNG不正、transport破損は別の失敗として扱い、URL候補を解放する。

### 13.4 Schedulerの最小責任分界

**Frontendはintent集約、Backendは送信直前のnative admission。既存の二つの所有構造を拡張し、別のnative dispatch queueは追加しない。**

Frontendは`useRawDocument`内のdocument ownerに表示slotを追加する。各kindにlatest未送信intent 1件、進行中fetch/decode 1件。任意のframe配列やsettings snapshot履歴を持たない。`RawControls.serial`はmutation intent世代、renderSerialは表示要求世代として区別する。Backendは現行`_pending/_before_pending/_running`と`_worker`を拡張し、それぞれ最新1件・実行1件を維持する。Frontend slotは操作イベントをACKへ束縛するため、Backend slotは複数HTTP到着・native lock待ちを制御するために必要であり、同じnative操作を二重実行しない。

| 契機 | 確定する発行規則 |
|---|---|
| begin/change | 表示interaction世代を進め、未送信Fullと旧画像候補を失効。変更は従来のdebounce/最新patchへ渡す。ACKされた中間値が現在intentならDraftを1件残す |
| end | 既存`flushControls`と同時に表示終了意思を記録。gestureがHistory ACKまで残ってもDraft扱いを続けない。最終patchのreadbackを待ち、保存fenceがあればその後に最終Fullを1件発行。pending空・no-opでもDraft表示からFullへ戻る |
| number/keyboard/wheel | 共通Sliderの既存begin/change/commitを使う。Enter/blur、Escapeの元値復帰、500ms静止、focus移動/unmountを維持。独自のFull確定timerを増やさない |
| Reset/category | `operate`のnative操作＋History ACK検証後にFullのみ。失敗中は古い画像を最新結果として示さない |
| Undo/Redo/jump | 既存gesture commit→move→readback→DB ackを優先。成功settingsへFull。旧revisionのDraft/Full候補を破棄 |
| view更新 | 操作中Draft、それ以外Full。同revisionでserial/viewGenerationを進めて集約。A2/A3のsizeは既存安全範囲内。最終的な解像度policyは未決定 |
| Before | 比較要求時のみ、Afterより低優先で同geometry/quality/sizeを要求。未送信Beforeは最新keyへ置換。Before失敗はAfter編集・保存を止めない |
| 写真切替/再生成/離脱 | 新inputをfreeze、未送信表示を破棄、mutation/History保存fenceを完了。旧ownerが送信済みnativeを回収しrelease。候補URLは即時非表示・解放し、新ownerへ移さない |

同一controlのactiveなbeginはidempotentとし、保存lock/旧owner等で拒否されたcallbackは表示interactionも開始しない。既存handoffで受け付けた次controlは前gestureのACK後に同じcoordinatorから有効化し、前revisionを次controlのDraftとして発行しない。表示側が保存coordinatorと別の「受理済み編集」を推測しない。

**未送信Fullの遠隔失効**：UIでの破棄だけでは、すでにHTTPからBackend pendingへ入ったFullを止められない。A3では同じdocumentの`POST /preview/cancel`を最小追加し、bodyを`workspaceId/generation/documentToken/kind/serial`に限定する。現在ownerかつ同ticketだけをabandonedにし、pendingなら204で完了、runningなら採用資格だけ失効してnative処理は回収する。cancelはnative/HTTP mutation lock待ちをせずevent loop上の短いowner検査で実行し、画像枠を消費しない。未知の古いserialは同owner内でno-op、別ownerは既存conflict。不正bodyは400。これはnative preemption APIではない。

begin/change、view置換、離脱で既存進行中serialのcancelをbest-effort送信する。応答が失われてもFrontendはその結果を採用しない。cancelがserverへ届く前にnative送信したjobは回収対象となる限界を明示する。新要求を送るために送信済みMCPをabortしない。通常fetchのabortだけでBackend ticketが取消済みと仮定しない。cancel専用の再送履歴・永続状態は作らない。

### 13.5 待機境界・lock・保存fence

| 区間 | ownerと待機保証 |
|---|---|
| ① mutation/readback/History transaction | Frontend既存ownership queue、HTTP制御owner、adapter `_submit`。保存成功はこのreadbackとCAS/receipt/current検証で決める |
| ② RenderJob〜MCP応答回収 | adapter既存worker＋native lock、MCP transport lock。同期処理完了を必ず回収。**PNG encode/Base64/pipe応答の受信も現行inline方式ではここに含まれる** |
| ③ PNG検証/HTTP body/decode | Backend画像owner／hook表示slot。native/保存queueから分離。Pillow workerのjoinは維持 |
| ④ Viewer公開 | hook/Viewer。owner・最新target確認後にURL/frameを交換。保存の成否を変えない |

具体変更は次で確定する。

- **`RawControls.flush/retry/settle`**：busy/unsettled/errorはmutation/readbackへ限定。readback通知で表示intentを同期登録し、flushは画像Promiseを保持しない。表示Promiseはhook slotが責任をもってcatch/finally回収する。`settle`は従来queue barrierとaccepted handoffを待つ。画像失敗をcontrols.errorへ書かない。
- **`RawRecipeSave`**：同じ保存queue、retryRequest、saveId、CAS、current/ack照合を維持。`sendHistory`の`await controls.refreshPreview()`を、成功settingsへのFull intent通知へ変更。gesture／operation/movingの解除は画像ではなく従来の保存条件に従う。変更途中のgesture保存を画質更新で増やさない。
- **`useRawDocument`**：既存`ownership/enqueue`はmutation/save/open/releaseだけを直列化。初回openもsettings/restore/History初期化を画像公開と分け、first Fullを表示slotで処理する。display errorとsave/native errorを別stateにし、画像取得失敗時でもACK済み編集の保存を継続できる。decode後の`readRawDocument`は表示slot内に残すが、既存queueへjoinさせない。`prepareSave`はdisplay slotを待たない。
- **HTTP admission**：`_execute`の制御直列化は維持。`_preview`は短いowner検査・ticket登録後にlockを解放し、PNG待機後に短く再取得して応答検証。制御taskは既存最大2枠を維持し、画像taskをその2枠から除外する。通常の画像slotはrunningまたはvalidationの1件＋After pending1件＋Before pending1件。同workerのrunning/validationは排他的、旧pending置換時に即204で解放する。HTTP bodyへ移譲したticketも送信完了／切断まで同じ画像leaseを保持し、pending/実行/validation/転送を合計した画像ownerは最大3件とする。空きがなく旧pendingも置換できなければ`raw_busy`で拒否する。同ticketへ無制限にwaiterを追加しない。body転送はnative owner解放後に行い、transport側の切断/deadline回収は画像枠だけへ作用し、制御枠を占有しない。
- **制御fence**：HTTP制御受付時、adapterへ短いcontrol reservationを登録し、制御task完了まで保持する。特にHistoryはreadback→SQLite transaction→receipt/current確認の**全区間**で保持する。この間、新renderを開始しない。native readback後にrenderの`accept`が割り込み、保存対象settingsを変える競合を避ける。受付済みmutation/lifecycleも同様。予約はfinallyで解放し既存workerをwakeする。別のFIFO native queueは作らない。
- **`LightCraftRawSession._previews/_submit`**：既存native lockを維持。render workerはcontrol reservation/待機中`_submit`があれば送信を保留し、lock取得後にも再確認する。確認から送信ownership確保まではevent loop内で競合しないようにする。native占有はrender応答回収→完全settings readback→ticket snapshot/整合判定まで。その後lockを解放して`_image`へ渡す。Beforeの`accept`もAs Shot学習を起こし得るため、Beforeにも同じ整合確認を行う。
- **画像owner**：既存workerはlock解放後も1件の`_image`を所有し、validation終了/joinまで次renderを始めない。新mutation/保存は進められる。PNG metadata/CRC/Pillow検証を緩めない。検証中にrevisionが進んだ画像はstaleとして捨てる。native checkのためにvalidation完了を待ち戻さない。
- **`LightCraftMCP.request`**：送信〜応答lock、送信後timeout/cancelの接続喪失規約は変更しない。アプリ都合のstaleはticketの採用資格で処理する。③をMCP transport ownerへ戻さない。

**lock順序**：HTTP制御lock→adapter native lock→MCP lockは既存順を維持する。render workerはnative lockを持ったままHTTP lockを取得しない（逆順deadlock禁止）。render readbackのsnapshotはadapter内で確定し、HTTP応答／次の`_document`取得時に短い同期reconcileでdoc revision/fingerprintへ反映する。reconcileは同raw handle・同generation・synced・完全readback済みのsnapshotだけを使い、DB recipeRevision/receiptを更新しない。History pendingを解決済みと見なさない。相違時の既存revision conflict/unknown処理を維持する。

release/close/resetは表示の未送信slotを止め、制御fenceと送信済みnativeをdrainし、validation worker・一時file所有を回収してからsource/sessionを解放する。`_history_checkpoint`をPNG結果で代用しない。save成功通知は③④を待たないが、**資源解放のためのclose待機**は別に残る。③のAfter不正画像で現行fail-closed規則によりSessionが失われた場合、確定済みSQLite receiptは取り消さず、進行中保存は既存owner/current照合でunknown/失敗を判定する。画像成功で保存成功へ昇格させない。

保存fence・新編集は未送信Full/Beforeより優先する。一方、送信済みFullの②が終わるまで次のnative確認は待つ。A工程はこの待機をゼロにするものではない。MCPのPNG/Base64搬出まで分離するには別transport変更が必要であり、A2/A3では実装しない。

### 13.6 初期安全上限・将来regionへの接続

A2/A3はGenzoRoomの長辺1024/pixels≤1024²、PNG5MiB、Base64上限、metadata16KiB、MCP line8MiB、通常line1MiB、request4KiBと既存timeoutを維持して測定を開始する。これらは**初期実装の安全枠**であってDraft/Fullの製品画素数・最終予算ではない。qualityごとに解像度を固定せず、測定時に同寸法比較も可能にする。

new metadataが16KiBを超えたら応答失敗にし、無制限に拡張しない。A2のMCP自体の既存4096clampも変更せず、A3の要求はより狭い既存制約に従う。PNG→Base64→lineの整合、pre-decode pixel検査とPillow worker回収を維持する。容量緩和・file転送はB以降の測定判断とし、必要なら§9.2の検証・disk/file所有・quotaと同時に行う。disk cacheを禁止する決定ではない。

工程Cの`render_region`もquality/preview_contract/stage_cache/Before/envelopeを共有し、仮想full frame寸法とwindowだけを追加する。geometryIdはwindowを含まない、render identityはwindowを含む。返却windowはfull frame座標、tile bitmapとは独立。領域専用の別native ownerや保存queueを作らない。Draft/Full両regionが最終必須であり、A2/A3で非対応を広告することを最終完了と混同しない。

### 13.7 StageCache：A工程で比較可能にする確定方針

**A2でoff/onの評価経路を用意し、最終採用はAのWindows測定で決める。** no-cacheを必須の製品方針にも、常時cacheを必須にもせず、A工程中に有効性が確認できれば採用できる。A3の内部developer測定設定から`stage_cache`と試験用budgetを指定できるようにし、通常UIの品質buttonやRecipe設定は追加しない。defaultは従来どおりoff、on設定には明示的な有限budgetを必須とする。

- Headlessがactive photoのAfter用／Before用の`Arc<StageCache>`を各1個保持し、`with_stages`へ渡す。quality別には分けず、同じsideでDraft→Fullのnative再利用を可能にする。size別entry管理は既存StageCache（既定2件）へ任せ、windowごとの無制限mapを作らない。Cでwhole/regionを別slotにする場合もpool総予算を共有する。
- offはjobにstagesを渡さず、Headlessのstage pool全体をclearする。mode/budgetを変更する時も両sideをclearしてから新条件で開始する。LCのsource cache・元RAW取得cacheはoffでも維持する。sourceとStageCacheを同時に無効化した比較を「StageCacheの効果」と呼ばない。
- settingsの色調変更だけで全clearせず、既存source/frame/size/lin/pre-NR/plane keyに再利用判定を任せる。Fullは通常Full jobで計算し、Draftの近似planeを無条件にFullへ昇格しない。NR Draftに意図された近似はoffと画素完全一致するとは限らない。
- photo/source内容/generationの変更、geometryまたはBefore基準変更、cache mode/budget変更、reset/close、memory pressureでclearする。BeforeとAfterのstageを共有しない。Undo/Resetではnative keyが有効性を判定するが、geometry等が変われば上記clearを優先する。
- retention予算はAfter+Before全体で一つ。`StageCache::bytes()`のCPU分だけでなく既存`lightcraft_engine::gpu::stage_bytes()`のdevice分を加算し、shared GPU sourceは`shared_source_bytes()`等で別計量してpeakへ含める。CPU源bufferの全寿命が`StageCache::bytes()`に含まれると誤認しない。
- on時budgetは実験ごとに明示し、既存engine budget（GenzoRoom設定1GiB）以下で検証する。これは追加1GiB使用許可ではない。追加保持がengineの既存memory gateに自動算入されるとは仮定しない。job前に不要sideをclear、checkedな保守的見積りでbudget内のcache利用だけを許し、見積不能なら`applied:false/reason:budget`でoff実行する。job後にCPU/GPU保持を再計量し、超過は非使用side→使用sideの順でclearしbudget内へ戻す。retainedBytesはtrim後、cpuBytes/gpuBytesはtrim前観測値とする。mode offはapplied=false/reason=none/budgetBytes=0。
- これはretention上限であり、現像中source/一時bufferのhard RSS/VRAM上限ではない。事前見積り・GPU/source計量・clear保証を固定sourceで実装できない場合、onは非対応として評価を保留し、必要な最小観測点を報告する。bytesを測れないままonを有効化しない。

測定は同source/同settings系列/同size/同backendでoff→onとon→offを取り、cold/warm source条件を別に記録する。Afterのtone/露光/NR変更→Draft連続→最終Full、Before両品質、size変更、clear後、GPU fallbackを含める。native処理・PNG encode/MCP・validation・decode/公開と、CPU RSS/VRAM/retained bytesを分けて測る。

正確性は最終FullをoffのFull（同backend/同revision/geometry/size）と比較し、CPU同条件fixtureでは画像一致、GPUは既存許容差方針に従い差分を記録する。NR Draftは近似再利用を許す既存native回帰を用い、最後のFullで精確な結果へ戻ることを検証する。誤ったsource/Before/geometry/sizeからのreuseは不合格。cache hitだけで速度・画質を保証しない。メモリ・ディスクcacheを一律禁止せず、今回新しい永続cache基盤を必須化しない。

### 13.8 A2/A3の変更境界・受入と持越し

| 工程 | 変更対象／依存 | 受入と停止条件 |
|---|---|---|
| A2：LC MCP拡張 | `tools.rs` schema/parser/helper、`headless.rs` job/metadata/stages、native fixture、管理Before patch/manifest、`build.py` probe/receipt、必要な更新手順。A1契約を入力とする | 旧省略Full/Before互換、同寸法Draft/Full両kind、型不正拒否、実quality/frame、geometry gate、stage off/onまたは明示非対応、固定source patch/実binary照合。実frame取得や正しいsource acceptがMCP内だけで成立しなければ§13.2 gateで停止し報告。現像式変更へ進まない |
| A3：GenzoRoom接続 | runtime/MCP typed capability/error、adapter ticket/worker/validation/control reservation、HTTP preview/cancel/admission/reconcile、rawApi、hook表示slot、RawControls/RawRecipeSave通知、RAW Viewer frame descriptor。A2実binary契約に依存 | 最終ACKへのFull、同revision品質切替、未送信集約/取消、stale破棄、PNG検証/decode停止中の保存完了、readback→SQLiteのrender割込み防止、旧owner回収、Before失敗時After継続、JPEG回帰なし。saveId/CAS/unknown/History200/再生成・終了保証を維持。画像errorと保存errorを分ける |

自動テストはR1§10の関連suiteを再利用し、追加gateを設ける。Backend fakeは②render/応答、native readback、③validation、SQLite transactionを独立gateで止め、**validationを止めたまま保存が完了すること、DB確定中には新renderが始まらないこと、renderがnative lock保持中でもHTTP cancelが完了すること、releaseがlock逆順でdeadlockしないこと**を確認する。Frontendは同revision Draft→Full、begin対pending Full、遅い画像/decode、no-op/Escape、Reset/move、unknown save再送、旧owner callbackとJPEG切替を検証する。既存fakeの成功をnative frame・実GPUの成功に拡張しない。

実機測定はA2/A3の最小縦接続と必要な自動検証後に開始する。初期安全枠の同寸法off/on・Draft/Fullで比較し、保存/新編集が同期Full応答を待つ残余時間も測定する。測定前に固定しない項目は、Draft/Full画素数、whole/region閾値、最終PNG/MCP/cache容量・timeout、高画素whole上限、cache最終構成、CPU/GPU性能保証。実frame観測方法・stage計量の実装gate、異geometry比較mapping、B/Cの資源緩和とregion実装は持越す。

### 13.9 A1の確認・停止範囲

今回の変更は本書へのA1契約追記と優先順位注記のみ。参照先、既存C4保証と各新契約の対応、型／metadata／lock順／callback所有の整合を静的確認し、`git diff --check`を実施する。build・テスト・実binary検証・Windows測定・ブラウザ操作は行わない。指定のCommitメッセージは`docs: RAW適応型プレビューA1のAPI・所有権契約を確定`。本書だけCommitして`origin/feature/lightcraft-integration`へPushし、A1で停止する。A2の実装には進まない。

## 14. A2実装結果（2026-10-24）

開始HEAD `7fd31d18fc77c7782b01aac7234afc760ef6bf93`、`feature/lightcraft-integration`、作業ツリーclean。LC参照checkoutは固定`a2a41383c4fd62fa85a46ccd00998639221f2d3c`、既存Before変更3ファイルを確認・保護した。専用ローカルコピーを固定commitから作成し、従来管理patch適用後に変更した。upstream更新・fetch/pull/reset、実Immich書込みは行っていない。以下はA2の実装・自動検証記録であり、§13の未決定な性能仕様を確定するものではない。

### 14.1 Geometry gate：通過、実Planの観測sidecarを採用

公開APIで別の`pipeline::plan`を実行する案では、CPU/GPUで適用されるsection bypass／rendition／profile／Upright／automatic CAと、成功した実Planの同一性を戻り値から確認できなかった。そのため許可された最小metadata accessorとして、`Rendered.frame: Option<geometry::Frame>`を追加した。CPUとGPUの成功経路が**実際にsampleへ使ったPlanのframeをclone**して返す。失敗してCPU fallbackした場合は成功したCPU側のframeとなる。画像演算、設定解決、GPU選択・fallback、source選択は変更していない。thumbnail/slide/cached stand-inの既存constructorはNoneとし、実geometryの証拠にはしない。UI側の変更は既存テストconstructorへのfield追随だけで、UI動作変更はない。

headlessは既存`render_job → run → accept`の戻り値からframeを取得する。metadataのための別decode、追加Full-source decode、別の自動geometry推定は行わない。`Frame::native_size_at(original_w, original_h)`は**実Planで確定済みのnormalized crop**を、LC importで把握したEXIF-oriented原本gridへorientation込みで投影する。再度lens/constrain/Uprightを計算せず、PNG寸法やnative_longから原本短辺を推測しない。source levelに依存した推定差がある場合は、そのrenderの実変換を返す。aspectは実frameの連続aspect、nativeWidth/Heightは原本gridの論理寸法の丸め、fullWidth/Heightは実bitmap寸法である。

geometryIdはsource内容identity、原本grid、実source aspect、orientation、実crop/straighten/flip、実perspective/distortion/CA/embedded lens warpからSHA-256で生成する。要求size、quality、色調値、gain-only vignettingは含めない。座標値の非finiteを拒否し、window frameはA2では明示的に未対応とする。Beforeはnative import Beforeのframeを返し、After opticsを転写しない。工程Cではfull frameとwindowの追加観測が必要だが、既存品質／owner／座標契約は維持する。

native fixtureでcrop/rotation/flip/straighten、embedded lens、constrain、automatic CA/Upright、bypass後の実Plan一致を確認した。奇数の原本寸法を使い、Preview source寸法との独立を検証。Engine fixtureでは1回のdecode後に`accept`して次jobがLoaded sourceを再利用することを確認した。synthetic GPU fixtureも実行され、返却frame／実寸とGPU Planの一致・保持source計量が成功した。実RAWのgeometryを全機種・全設定で実機受入済みとする記録ではない。

### 14.2 品質・互換・エラー

`render_preview`と共通`render_photo` helperへA1のquality/preview_contract/stage_cache/budget parser・schemaを追加した。quality省略はFull、Draftだけ`.draft()`を付与する。応答qualityは要求文字列のechoではなく、実行する`job.request.quality`から取得する。Before/After両方で成立し、品質操作によるnative History/interaction/settings更新はない。

従来引数のみなら既存Fullとmetadata形状を完全に維持する。adaptive時だけpreviewContract/quality/mode/frame/stageCacheを追加し、従来Beforeのkind/fingerprint/geometry fieldは維持する。headless以外は明示capabilityのないbackendを描画前に`preview_unsupported`として拒否する。新契約の失敗は固定JSON codeへ正規化し、upstream例外・temp pathを返さない。adaptive画像のpath metadataは除去する。

`obj()`がnull引数を落とす既存共通動作に依存しないよう、元引数を転送前に検証する。quality/contract/cacheの型違い・未知値・null、budgetの欠落/zero/負値/非整数/過大値をjob前に拒否。beforeの非booleanも拒否する。MCP helperの既存4096 clampは維持し、adaptive PNG5MiB・metadata16KiBを追加検査する。これらはA工程の安全枠であり最終解像度・容量仕様ではない。

### 14.3 StageCache off/onと有限retention budget

Headlessの`StagePool`はAfter/Before各1 cache、各cacheの既存2-size retentionを利用する。quality別には分離せず、同sideのDraft→Fullで再利用できる。offはpool全体をclearしstagesを渡さない。onは明示的な有限budgetが必須で、native memory budget超過の要求を拒否する。source/写真、geometry、Before基準、mode/budget、library lifecycle・memory budget変更で適切にclearし、失敗時もpoolを解放する。同じ写真への`library.select`、`library.state/memory`はcacheを消さず、実source変更はrender時のsource keyで失効する。source cacheはoff/on双方で維持する。

追加した計量はCPUのchroma bufferとstageがpinするsource、GPUのchroma/device bufferとhost source参照を含む。別cache／CPU-GPU間で同じsourceを共有する場合も各ownerへ保守的に課金するため、pool計量は重複共有分を含む**安全側のbuffer保持上界**でありRSS値ではない。nativeの共有source cache／driver pool／現像中の一時bufferは別のowner・予算であり、これをプロセス全体のhard memory capとは扱わない。

checkedな事前見積りが予算内の場合だけstagesを付与し、見積不能／予算不足ならoff描画へfallbackして`applied:false, reason:budget`を返す。現在の見積りは2-sizeのCPU/GPU planeとsource参照を安全側に見積もるため、実際には収まる要求でもcacheを使わない場合がある。描画後もAfter/Before合計を再計量し、超過時は非使用side→使用sideの順で破棄する。cpuBytes/gpuBytesはtrim前、retainedBytesはtrim後、budgetBytesは要求されたpool上限。metadataにCPU/GPU/source retentionが含まれていることをA3の計測でも維持する。

unit/MCP/実binaryでoff/on、同side reuse、Before/After独立、source変更、tiny budget fallback、post-render eviction、chroma/pinned-source計上、NR Draft後の最終Fullとuncached Fullの一致を確認した。StageCacheの最終採用、速度向上率、最終budget、実RAW/GPUのpeak RAM/VRAMは未測定である。

### 14.4 管理patch・build・検証

管理対象は既存`0001-native-before.patch`1本へ統合した。manifestのnative targetsは17件だが、Engine/pipeline/GPUの変更はmetadata sidecar・buffer計量とfixture、stand-in constructor追随に限定し、現像アルゴリズムを改変していない。新規`preview.rs`を完全diffへ含めるため、`build.py --apply`は`git apply --intent-to-add`を使う。管理外untracked source／staged内容／部分適用／二重適用の拒否と、source完全diff照合を維持する。

- 最終patch SHA-256：`3ac3bab2e024d1226ffe536a2325959d228635558e0fdcfafb1c84fd1e5eba70`。
- 最終release CLI SHA-256：`b0fbade4ab598614e03af4c29fecfe0a3f0f000642072d602495ae8b15d78aeb`。
- `build.py --build`：MCP回帰、release CLI build、生成binaryのschema／legacy Full／Before／4品質組合せ／frame／cache off/on/tiny budget／不正引数／settings不変probe成功後、beforeContract=1・previewContract=1のreceiptを生成した。
- 別の固定commit clean copyへ最終patchを適用し、manifest/source完全一致、native `git diff --check`、二重適用拒否を確認した。`--binary`でreceipt/digest/能力を再検証する手順も更新・実行した。
- native MCP：**63 passed、既存補助1 ignored**（unit 53、e2e 10）。pipelineのgeometry/計量2件、Engineのdecode/accept1件、synthetic GPUのframe/計量1件も成功。途中のRust fixture借用エラーはfixture修正後、対象focused testで解消した。
- 管理patch Python回帰：repo Python 3.14、cwd backend、`tests/test_lightcraft_patch.py` **4 passed**。新規sourceのintent-to-addと管理外untracked拒否を追加した。製品Backend/Frontend全suite、Docker Smoke Testは実行していない。
- build環境にはcraft-fonts未埋込みの既存警告がある。今回のRAW pixel/geometry契約とは別のCJK文字描画制約であり、このCLIの日本語文字合成機能を検証済みとはしない。改行変換警告はpatchのLF digest・完全diff照合で管理した。

限定監査は品質引数の転送、旧strict metadata互換、実Plan/sidecar、source cache/accept、Before非転写、cacheのbuffer計上・破棄、typed error、patch/receiptを対象とした。nullが転送前に省略される問題、source/chromaの計上不足、応答qualityの実job参照、post-render evictionの検証を補強した。完了監査では同一写真の再選択／memory診断でもstageを消してしまうMediumを修正し、既存RAWの操作経路との接続回帰を追加した。MCP回帰・release build・実binary probe／receipt・最終clean適用を再検証し、未解決High/Mediumはない。全機能・全障害の網羅監査を行ったという意味ではない。

### 14.5 A3への引継ぎと停止

GenzoRoom製品Backend/Frontend、SQLite、Recipe/History、既存C4完了記録、README/CHANGELOGは未変更。`backend/tests/test_lightcraft_patch.py`の変更はnative build管理回帰のみ。実binaryとreceiptはignored専用checkout `.tmp/lightcraft-a2/target/release/`に保持し、既存参照checkoutのbinary／環境設定を置き換えていない。

A3ではquality/frame/stageCacheの世代capabilityとstrict検証、HTTP preview/cancel、control reservation、PNG検証・decodeと保存fenceの分離、表示intent・RAW論理尺度を接続する。Beforeの異geometry mappingは未解決事項のまま明示し、region APIは工程CでDraft/Full両方へ拡張する。実RAWの性能、stage cache効果、色・細部、Windows表示条件、長時間・メモリ受入はA工程の実機測定へ残す。A2で停止し、A3接続や領域描画の実装には進まない。

## 15. A3接続実装（2026-10-24）

A2 commit `ad1a3a98f65a77d69af3639fcfb0de923d8a8405`のclean treeから、既存Windows RAW経路へ接続した。LightCraft upstream commit／管理patch／binary、SQLite schema v8、JPEG Recipe v18、既存C4完了記録は変更しない。本節はA3の現行契約であり、前節までの工程別「未接続」はその時点の記録として保持する。

### 15.1 MCP・HTTPと実geometry

- runtimeはgenerationごとにquality enum、contract=1、cache enumとbudget型を確認する。Before booleanは独立判定。対応schemaを持つ場合だけ`quality/preview_contract=1/stage_cache`を送信し、実応答のcontract／quality／kind／whole／frame／cacheをPNG workerで厳格検証する。新schemaの不正応答をlegacyへ格下げしない。
- 旧binaryには従来引数だけを送り、実際のFull wholeを返す。HTTPに`X-Raw-Preview-Contract:0|1`を追加し、legacyのFullとnative frame未取得を明示する。Frontendはcontract=0でnative寸法を捏造せず、従来PNG尺度へ限定する。Before非対応はAfterを停止しない。
- HTTP adaptive bodyは§13.3のowner／revision／kind／serial／quality／mode／maxSide／viewGeneration／geometryId。省略qualityの旧bodyも維持する。geometryはrender付帯のみで取得し、queryは追加しない。`X-Raw-Frame`は検証済みnative frameで、geometryIdをsource/document/generationへ再束縛する。native PhotoId、path、settingsは返さない。
- wholeのbootstrap、settings revision変更、新品質でまだ実frameを観測していない場合はgeometryId=null。同revision・同品質のview再要求には公開済みgeometryIdを指定する。Draft／Fullでeffective geometryが異なる可能性を推測で同一扱いしない。nativeWidth/HeightとPNGのwidth/height／fullWidth/Heightを分離する。
- MCP固定error allowlistだけを抽出し、入力400、非対応503、geometry取得不能502、予算413、画像不正502へ§13.1どおり変換する。未知tool errorは従来の固定code、transport errorは従来規則を維持する。正常旧結果は204と`X-Raw-Superseded-Reason:revision|replaced|cancelled`。Frontendはrevisionだけを既存owner queueで一度再同期し、mutation／未知保存requestを再送しない。
- Base64／metadata allowlist／CRC／IEND／単一frame／Pillow verify/load／pixel・byte制限は維持。Frontendもheader／frame／PNG実寸／decode実寸を検証し、header拒否・失敗時もresponse bodyを解放する。

### 15.2 表示scheduler・状態の責任

| 状態 | owner・更新条件・不変条件 |
|---|---|
| confirmed native revision、controls serial／pending／desired | 既存RawControls。serialは編集意図であり、画像品質変更だけでは進めない。busy/error/settleはmutationとreadbackのみ |
| interacting | RawControlsの表示専用状態。RawRecipeSaveが受理したbegin／handoffで開始、end／History移動／操作／commit確定で終了。History ACKまで残るgestureとは別 |
| renderSerial／displayGeneration／viewGeneration | hookのdocument owner。kind別serial、新編集・view置換で旧候補を無効化。Afterは未送信1件＋fetch/decode1件。31-bit serial上限前に既存再生成経路へ入り、wrapしない |
| displayPending／transmitted／公開URL・frame | hook表示slot。画像Promiseをcatch/finallyし候補URLを解放。旧結果は公開しない。Fullは保存coordinatorのlock解放後、最終ACKのsettingsへ束縛する |
| native pending After／Before／running／validation | 既存adapter worker。After優先、各pending最新1件、runningとvalidationは同時に増やさない。別のnative dispatcherは追加しない |
| HTTP画像lease／latest serial | API。最新serialは現documentのkind別2件だけ、document openで破棄。画像leaseは最大3件。制御2枠とは分離 |
| Before基準／比較URL | import/process/crop/orientationの既存基準keyと、品質・実geometryを分ける。Before URLを同pairで再利用できるが、現在After画像のrevision・品質・geometryが揃わなければ比較として表示しない |

操作中のACKはDraft、操作終了と保存ACK後はFull。pending空／no-opでも終了intentがFullへ戻す。数値入力、Enter／blur／Escape、keyboard／wheelの500ms確定、focus／unmountは共通Sliderの既存境界を使い、新timerを追加しない。Reset／カテゴリ操作／Undo／Redo／jumpは既存History ACK後にFullを通知する。ハンドオフの未ACK intentを前controlのrevisionで描画しない。

viewport／zoom／pan／DPR／geometry変更はviewGenerationとserialを進める。編集中ならDraft、それ以外Full。Bの解像度policyは実装せず、両品質とも現行1024安全枠を使う。RAW Viewerはnative論理frameでFit／Zoom／Panを計算し、1:1はscale=1/DPR、表示間のDPR変更でも物理倍率を保持する。bitmap交換だけではtransformを初期化しない。JPEGの尺度・Preview/Original経路は維持する。

Beforeは要求時のみ低優先で取得し、品質と実geometryを検証する。異geometryはAfterを保持して比較errorとし、stretchで同一座標と扱わない。native Beforeがreadback revisionを進める場合も同じ一度限りの再同期経路へ渡す。失敗はAfter編集・保存から分離する。adaptive BeforeのBackend完成画像cacheは実geometryを再確認せず使わず、Frontendの有効な比較URLとnative StageCacheを再利用する。旧legacy Before cacheは維持する。

### 15.3 native・保存・画像の待機境界

1. Frontend既存ownership queueはopen／restore／mutation／History／save／releaseを所有する。初期History保存と画像公開を分け、RawControlsとRawRecipeSaveは画像Promiseをawaitしない。prepareSaveはnative readback／saveId／CAS／receipt/current照合までを待ち、fetch／decodeは待たない。表示errorは独立し、専用Retryも保存再送を行わない。
2. HTTP制御受付でadapter control reservationを同期取得し、完了callbackで解放する。Historyのreadback→SQLite transaction→receipt/current照合まで保持。内部checkpoint／closeも予約する。既存_submit待機中／予約中はworkerが新renderを送らず、native lock取得後にも再確認する。
3. native lock内で同期RenderJob、PNG encode／Base64／MCP応答回収、完全settings readbackを完了する。Beforeにも適用。helperがaccept後にtool errorを返す場合もreadbackする。正常renderのreadbackが変化すればrevisionを更新し、画像は204 revisionとする。transport lock・送信後timeout/cancelのSession喪失規則は変更しない。
4. lockを解放してからPNG検証へ渡す。同workerが検証threadを保持し、timeout後もjoinする。検証中にmutation／保存を進められる。render workerからHTTP lockを取得しない。HTTPは短い登録と最終検証だけlockし、ticket待機・body送信では保持しない。
5. 画像leaseは受付／pending／running／validation／HTTP bodyまで最大3件。全枠使用中でも同ownerの未送信旧ticketを204へ終端させ、最新へ置換できる。送信済みjobは回収する。body完了／切断／送信失敗でleaseを解放し、送信にも既存Frontend要求と同じ90秒の初期deadlineを使う。保存の制御受付枠を消費しない。
6. `/preview/cancel`はowner／kind／serialを検証する短いevent-loop処理。HTTP制御lockを待たず、pendingだけ破棄し、runningは採用資格のみ失効。hookはbegin/change、view置換、再生成／離脱でbest-effort通知する。HTTP waiter abortをnative cancelとは扱わない。release／closeはnative・検証・一時fileを既存ownerで回収してからsourceを解放する。

送信済みFull中は同期MCPとreadbackが後続操作を待たせる。完全preemptionは実装していない。Pillow不正などで後からSessionを失っても、完了済みSQLite receiptを取り消さず、未完了保存は既存owner/current検査で成功と偽らない。

**readbackの防御境界：** 再同期はsavedFingerprint／retryRequest／History checkpointを上書きしない。既に初期化済みでgestureのないnative settings差分が見つかった場合、保存は`raw_history_readback_mismatch`を返す。表示が勝手なHistory stepを作ったり、dirtyなno-op保存を無限反復したりしない。これは未知のnative変更を自動採用・破棄する新仕様ではなく、既存不一致を明示するfail-closed境界。固定nativeのAs Shot学習は`Op::SetAsShotWb`でcatalog属性だけを更新し、`develop.get`が返すdevelop自体を書き換えないことも確認した。故障注入ではAfter／Before双方のrevision変更・再同期と、保存checkpointを維持した拒否を検証する。

### 15.4 StageCacheの内部測定設定

通常はoff。Backend起動環境の`GENZOROOM_RAW_STAGE_CACHE=on`と`GENZOROOM_RAW_STAGE_CACHE_BUDGET_BYTES=<正の整数>`でA2のon経路を選ぶ。onは有限budget必須、現行native memory budgetの1GiB以内。不正値は明示拒否する。これは最終採用・最終予算ではなく内部測定の初期上限で、UI／Recipe／Historyへ設定を追加しない。HTTPからcache/budgetを入力できない。旧binaryのcontract=0はStageCache比較対象にしない。

debug診断はnative＋MCP＋readback時間、PNG validation時間、Frontend応答待ち／body read／decode時間、generation／revision／sequence／品質／kind／寸法／容量、cacheのmode/applied/reasonと保持byteを記録する。Full PNGのSHA-256はdebug時だけ算出し、同系列off/onの最終Full一致確認に使える。画像／settings本文／path／tokenは記録しない。ログ失敗は処理を失敗させない。

CPU比較は既存managerの`gpu_backend="off"`、GPU比較は`dx12`を明示して別generationで行う。ログのconfiguredBackendは設定値であり実GPU成功の証拠ではない。測定callerは既存`get_gpu_info()`も明示取得しfallbackを区別する。coldは新generation／再import、warmは同source・settings系列・サイズの連続描画とtrialIndexで区別し、trialIndexをnative cache hitと呼ばない。Before／AfterとDraft／Fullを別集計する。保持byteはRSS／VRAM peakではなく、後者はWindows実測で別途取得する。

### 15.5 検証・限定監査・残す範囲

関連Backend 488件、Frontend 9ファイル262件が成功。最後のadmission待機・離脱／再開の変更後、その影響範囲のBackend 121件／Frontend 94件を再実行して成功した（前記件数へ加算しない）。Pythonはrepositoryの3.14、FrontendはTypeScript検査を含む本番build成功。`git diff --check`と文書参照を確認した。全suite、ブラウザ手動動作、RAW実機性能試験の成功を意味しない。Frontendの既存panel-arrowテストでReact act警告2件、buildで500kB超chunk警告が出るが、失敗はない。

- A2の実binaryのmanifest／receipt／SHA-256を`build.py --binary`で再照合。A3 runtimeとstrict PNG validatorに合成PNGを通し、After/Before × Draft/Full × cache off/onの8組、Full off/onのbyte一致を確認した。native source／patch／binaryは変更していない。
- 回帰は旧／新schema、品質・geometry不正、同revision品質切替、pending置換、制御lock非依存cancel、PNG検証停止中のHistory保存、SQLite停止中のrender予約、転送中の3画像leaseと保存独立性、旧owner／timeout／close回収、C4保存・History・200操作／200/256再生成、Slider操作境界、DPR／Fit／1:1、Before不一致、JPEG経路を対象とする。
- 限定監査ではハンドオフの未ACK描画、重複Full、初期化／closeの待機境界、legacy Beforeのserial、metadata拒否時body解放、native不一致時のno-op保存反復、bitmap交換でfit effectが再発火する問題を確認し、実装・回帰で対処した。保存済みcheckpointと不明結果の再送規則は変更していない。

この変更境界の限定監査で未解決High／Mediumはない。通常のdisplay cancelはnative transportへ伝播させず、control待機は既存taskの完了を待ってbusy loopを避ける。HTTP予約の解放callbackも受付時のnative ownerへ束縛する。未送信表示を捨てて離脱し、離脱取り消し時には最新ACKへのFullを再要求する。

未決定は最終Draft／Full画素数、whole／region切替閾値、大画像上限、PNG／MCP／timeout／cacheの最終予算と採否、CPU/GPU性能保証。Windows実RAW・高画素・細部／色／NR・長時間／RSS/VRAM・Tauri表示は未検証。工程Bのwhole解像度policy、工程CのDraft/Full regionと異geometry比較mapping、RAW Export／Scope／配布／NASは実装していない。領域描画は最終必須要件として維持する。A3の接続と検証で停止する。

<a id="raw-preview-a4"></a>

## 16. A4：Developer Diagnostics測定タブ（2026-10-24）

A3 commit `d9de0f3345ad99ffeef1fea3d326c2ee665dce6a`のclean treeから実装。既存Logs／JPEG／WebGPU／Export EngineにRAW Previewを追加した。暗室の操作・描画policy、LightCraft source／patch／binary、SQLite v8、JPEG Recipe v18、C4完了記録は変更しない。A4は測定器の実装であり、実RAWの速度・画質・メモリ評価の完了ではない。

### 16.1 素材指定・所有権・API

素材は診断タブへImmich RAW Asset UUIDを明示入力する。Gallery選択は参照せず、既存`RawSourceCache`の原版download／形式・容量検証／private一時file管理を再利用する。任意ローカルpathのAPI入力、アップロード、Recipe復元、History・Immich書込みは追加しない。測定settingsは同じRAWのnative import defaultsに固定する。

Windows LocalHostだけが`POST /api/developer/raw-preview/{start,status,prepare,render,stop}`を公開する。既存認証、Host／Origin、no-storeを継承し、Dockerにはmountしない。`start`は`assetId, quality, stageCache, backend, temperature, repeats, budgetBytes`の完全一致allowlistを受ける。qualityはdraft/full/both、cacheはoff/on/both、backendはcpu/gpu、temperatureはcold/warm/both。応答の一時runIdと確定planを以後の要求へ渡す。prepare/renderはplanの現在index、status/stopはrunIdのみを受ける。HTTP画像応答は既存上限で検証したPNGと16 KiB以内の`X-Raw-Diagnostic` metadata。未知引数・不正値は400 `raw_invalid_request`、競合／旧ownerは409 `raw_busy`／`raw_stale_handle`、旧schemaは503 `raw_preview_unsupported`、実行／検証失敗は502の安全なcodeを返す。

通常編集managerを再利用して変更するのではなく、trusted executable設定をコピーした診断専用manager／processと`LightCraftRawSession`を所有する。CPUはGPU backend off、GPUはdx12を指定する。通常RawPreviewApiのadmission lock内で、workspace／task／image leaseがないときだけ診断を予約する。診断ownerがある間は通常workspace作成を拒否し、既存編集中Sessionを奪わない。通常process、native generation、save owner、Recipe／History queueには触れない。

| 一時状態 | 所有者・更新と不変条件 |
| --- | --- |
| 条件・plan・結果・UI phase | `RawPreviewDiagnostics`。明示Start時に条件を固定、結果は最大40件。次runで置換、永続化しない。 |
| runId・next/prepared/group・baseline settings fingerprint・binary SHA | `RawDiagnosticsApi`。一つのrunだけが所有し、順番どおりprepare/render。別groupも同settings／binaryでなければ失敗。 |
| native／HTTP操作と画像lease | Backend owner task一件・転送lease一件。HTTP waiterの離脱は送信済みnativeをcancelしない。次画像の準備は前lease解放後。 |
| 診断process・source cache | 診断ownerがclose成功まで保持。回収失敗はcleanup_failedで所有を残し、新run／通常workspaceを拒否して再試行可能にする。 |
| Frontend controller／Blob URL | コンポーネントが所有。decode後／失敗時にURLをrevoke、離脱後の結果を表示しない。 |

### 16.2 品質・cache・Cold/Warm・上限

`LightCraftRawSession`作成時の明示stage_cache／budget設定をnative render引数へ渡す。環境変数を書き換えず、通常編集は従来の環境変数設定を引き続き使う。品質は既存A2のdraft/fullを使用する。cache／品質／temperatureが変わるgroupごとにprocessを再作成する。

- **Cold**：各計測前に新process／再import。OS page cache、disk cache、GPU driver cacheのcoldは保証しない。
- **Warm**：同groupのprocessで同じ品質・cache・settings・寸法の描画を一度行い、その非計測warmup後に連続計測する。描画回数をcache hitと表示しない。各品質groupは独立し、Draft→Full再利用そのものを測る機能ではない。
- prepareでdownload／start／import／warmupを完了してから、独立render HTTP要求を計測する。sourceは一run中一度downloadする。
- repeatsは1〜5、最大40計測。cache ONのbudgetは正整数、最大native上限1 GiB（UIはMiB指定、初期値512 MiB）。OFFも入力条件を保持し、実際のmetadataはbudget 0で区別する。初期値は最終採用予算ではない。
- 全体描画のmax side 1024／PNG 5 MiB／metadata 16 KiBを維持。結果保持はmetadataと時間だけで画像蓄積をしない。source容量、import／render／validationの既存安全上限も維持する。
- runは600秒で新規受付停止、操作のないownerは120秒で回収、body送信90秒、Frontend要求180秒、decode10秒。run期限は送信済みMCPの強制preemptionではなく、既存native timeout／応答回収後まで延び得る。

### 16.3 測定値・比較・JSON

| 項目 | 実装上の意味・未取得の扱い |
| --- | --- |
| Native ms | A3 render workerの描画開始からMCP応答・settings readback完了。encode／readbackを含み、純粋な現像式時間ではない。 |
| Validation ms | native所有lock解放後の既存PNG検証。Full SHA計算は別overheadとしてTotalへ含まれる。 |
| responseWait ms | Frontend render開始からHTTP応答取得まで。native／validationとGPU状態照会・settings事前確認等を含む。JSONへ記録する。 |
| Transfer／Decode／Total ms | body read／Image.decode／render要求開始からdecode終了。それぞれFrontend時計で測り、準備時間を除く。純粋な回線時間とは呼ばず、異なる時計の差分や単純加算でnative時間を推測しない。 |
| PNG／cache | 実bitmap寸法・bytes、mode/applied/reason、CPU/GPU/retained/budget bytesを検証。保持容量はRSSやVRAM peakではない。 |
| CPU／GPU | 設定値と実行確認を分離。CPU設定offかつ前後app.gpu.enabled=falseのときCPU確認。GPUにはjob単位の成功証跡がなく常に実行経路未確認。lastFallback本文は出力せず報告有無だけを表示する。 |
| RSS／VRAM | 今回は収集せずnull／未取得。OS計測を実装したと誤認させず、実機評価で別途取得する。 |
| 結果 | success／failed／cancelled／unsupported。未取得時間はnullであり0を補完しない。失敗はcodeのみ、upstream本文は表示しない。 |

品質／cache／temperature等の同条件ごとにNative／Validation／Transfer／Decode／Totalの中央値・最小・最大・有効件数を表示する。Native中央値のFull÷Draft、OFF÷ONは、source identity・settings fingerprint・実frame・contract／binary・Backend・寸法・temperatureが一致し、成功・実行確認済み・fallback報告なし・ON実適用の組だけ計算する。Full OFF/ONのPNG SHA-256は同条件の同repeatを組み合わせ、一致／不一致／未検証を表示する。GPU未確認や条件違いを一致扱いしない。統計もgeometry等の異なる結果を同じgroupへ混ぜない。

専用JSONは`schemaVersion: 1, reportType: raw-preview`。GenzoRoom build情報、測定日時、LC version/commit/preview contract/binary SHA、元RAW寸法・形式とhash identity、固定条件、個別値、統計・比較・制約をallowlistで投影する。Asset UUID、path、画像・pixel buffer、Blob URL、token、Recipe／History本文を含めない。応答metadataもstrict検証し、測定Backend／ON予算が固定条件と異なる場合は拒否する。既存Full／JPEG-only／WebGPU-only／Export Engine／Logsレポートのschemaと意味は変更しない。

### 16.4 Stop・離脱・終了・検証

Stop／RAWタブ非選択は停止flagとBackend Stopを送り、送信済み処理の応答を回収してからprocess／一時sourceをcloseする。pagehide／unmountは独立keepalive StopとUI waiterのabortを行う。HTTP切断はowner taskをshieldし、送信済みMCPを取り消さない。開始ACK紛失などでrunIdを取得できない場合もBackend idle watchdogが回収する。アプリ終了のlifespanは診断close→通常RAW close→通常manager closeの順で待機する。cleanup失敗後はownerを保持し、明示再試行を提供する。

検証はrepository Python 3.14.5でBackend関連192件、Frontend診断関連10ファイル131件が成功。専用テストはnative品質・cache実引数、Cold再生成／Warm事前描画、通常ownerとの相互排他・保存無変更、Stop／shutdownの送信済み応答回収、timeout／cleanup失敗と再試行、重複開始・旧owner、認証／Host／Origin・Docker非公開、条件違いの拒否と誤比較防止、null統計、JSON機密情報除外、decode URL回収、非対応表示を確認する。既存RAW adapter／runtime／Windows API／LocalHost／sourceテストと既存診断レポートを回帰対象に含めた。

限定監査はSession隔離、native／HTTP待機、回収失敗後の所有権、画像・metadata上限、比較条件とprivacyに限定し、回収失敗時のタブ切替による再試行UI消失と固定条件不一致応答を修正・回帰した。最後のbody-read計測境界調整後、Frontend専用27件を再実行して成功（前記131件へ加算しない）。TypeScript型検査を含む本番build、文書参照と`git diff --check`も成功。buildの既存500 kB超chunk警告は残る。この境界で未解決High／Mediumはない。実RAW性能、画質、RSS／VRAM、Windowsブラウザ／Tauri動作の実測は未検証であり、自動テストはその受入結果を意味しない。

### 16.5 Windows実機での測定手順と後続

1. 設定済みWindows LocalHostを起動し、暗室を閉じて通常RAW workspaceを解放する。Developer Diagnostics → RAW Previewを開く（開くだけでは実行しない）。
2. 測定するImmich RAW Asset UUIDを入力する。品質・cacheを両方、CPU、Cold/Warm、回数、有限budgetを指定してStart。画像は表示・保存せずdecode後に解放される。
3. Native等の個別値・中央値、cache applied/reasonと保持bytes、Full OFF/ON SHA一致を確認し、RAW専用JSONを保存する。小budgetでON非適用なら速度比・一致を未検証として扱う。
4. 必要ならGPU設定で別runを実行する。GPU未確認を実GPU成功と解釈せず、OSのRSS／VRAM観測と実行経路の証跡は別途取得する。Stop／タブ切替／終了後の回収と通常編集復帰も手動確認する。
5. 同じRAW・条件と実機環境を揃えて複数回比較し、高画素・細部・色・NRと長時間挙動を別途評価する。今回その測定は実施していない。

cacheの最終採用構成・予算、品質ごとの画素数、大画像上限、whole/region閾値、最終timeout、CPU/GPU性能保証は引き続き実測判断。A4の診断機能で停止し、工程Bの解像度policy・工程CのDraft/Full regionには進まない。領域描画は最終必須要件として維持する。

<a id="cpu-stage-admission-p0"></a>

## 17. A5-P0：CPU StageCache予算見積り（2026-10-24）

A5調査と追加実機JSONを受け、固定LC v0.10.0／本家commitを維持した管理patchのCPU admissionを修正した。基準GenzoRoom HEADは`a58917d7b38e2252a1bc37d7b31ecc28130a7b6e`。GenzoRoom製品コード、品質アルゴリズム、scheduler、Recipe／History／SQLite／API schemaは変更しない。§14.3の一律事前式はGPU／混在／情報不足のfallbackとして残し、CPU確定経路だけ本節が更新する。

### 17.1 修正前後の式と根拠

旧binary `b0fbade4ab598614e03af4c29fecfe0a3f0f000642072d602495ae8b15d78aeb`の追加JSONは3990×3000 DNG／1024×770／CPU／1024 MiBで、ON全12試行適用、保持84,367,360 bytes（GPU 0）、Full off/on 6組一致。Warm Native中央値はDraft OFF/ON=92.79/41.84ms、Full=93.81/40.49ms。これはユーザーの旧EXE実測で、新EXEの実測ではない。

旧式は`edge²×512 + max(originalPixels,2560²)×36 + existing CPU/GPU`。1024pxで最低737 MiB、当該元寸法では約922.96 MiBになり、512 MiBを拒否する。

CPU新式は、全side／各最大2 entryの既存CPU buffer実capacityをallocation identityで重複除外し、未計上のsource実capacity×12と、実Plan出力面積P×`(32 + sampled miss×12 + lin miss×12)`を加える。32は空間plane全種の置換余裕。既存entryはeviction前のまま課金し、置換中の旧・新buffer共存を覆う。sampled／linのhitはnativeと同じsource/geo/lin keyで判断する。source=2560×1925、出力1024×770の例では空pool約98.51 MiB、既存実測と同じbuffer構成でsampled/lin再利用なら約104.52 MiB。実capacityに応じたchecked判定であり、512 MiB固定許可ではない。

### 17.2 所有権と保護

Headlessはmode/budget変更を反映した後、GPU無効かつGPU host/device retentionがない場合だけ、guard内で一度sourceを取得する。同じDecodedSourceをjobへ渡し、cold loaded結果をSession.acceptへ戻すことでsource cache／decoder情報・As Shot学習の従来経路を維持する。見積り用Planもpanic guard内で計算する。

計量補助はpixel計算を変えず、すべての容量演算をcheckedにする。GPU有効・混在bufferが残る場合、または必要情報不足の場合は旧見積りへfallback。render後の保守的CPU/GPU計量・総budget超過trimとsource/geometry/lifecycle/error clearを維持し、metadataの意味は変更しない。cache-associated bufferピークの保護であり、decode/filter scratch／PNG等のworking memoryやRSS／VRAM全体の上限ではない。

詳細な計算、旧実測の解釈、C4の不変条件、実機で残す項目は[追従性能調査§10](RAW_PREVIEW_INTERACTION_PERFORMANCE.md#cpu-stage-admission-record)を参照。

### 17.3 管理build・検証記録

- 固定upstreamの別clean checkout `.tmp/lightcraft-a5-p0-final-apply`に最終patchを`--apply`で再適用し、全diffの完全一致を確認。build元`.tmp/lightcraft-a5-p0`も同じmanifest／全diff照合を通過した。
- 最終patch SHA-256：`00a8f1d127c6a04f64fa680f849cdda36c028f8936ed5771afc0d8883655d328`。manifestの対象ファイル一覧は維持し、管理patch内のheadless／preview／pipeline計量補助とテストを更新した。
- `build.py --source .tmp/lightcraft-a5-p0 --build`でMCP unit 58件・e2e 10件成功。既存subprocess helper 1件はignored。Focused pipeline 3件（共有source・capacity・置換ピーク等）、既存連続slider StageCache回帰1件、NR Draft→Full正確性1件も成功。GPU/mixed fixtureの追加単独実行ではGPU非対応による早期returnはなく、実device/host buffer保持を伴う保守的拒否を確認した（上記MCP件数と重複）。
- GenzoRoom関連Backendはpatch管理／RAW owner／runtime／Windows API／A4の5ファイルで133件成功・1件失敗。失敗したHTTP waiter取消・source回収の既存テストは、並行release compile終了後の単独再実行で成功した。製品Pythonは変更しておらず、負荷下での初回時間依存失敗を成功件数へ隠さない。最終manifestの管理回帰4件も再実行して成功（前記件数と重複）。
- CLI release build（`--locked --no-default-features -p lightcraft-cli`）と拡張MCP probe、receipt生成、さらに`--binary`によるreceipt／実SHA／probe再照合が成功。buildには既存のoptional craft-fonts未同梱警告があり、RAW画素処理の検証には使っていない。`git diff --check`と文書参照も確認した。

新EXE：`I:\code\genzoroom\.tmp\lightcraft-a5-p0\target\release\lightcraft-cli.exe`。

SHA-256：`53e59c9bdf18651bcd14edd9aa0c5801b16c8543d191f164b060077fbe0b6511`。

隣接receipt：`I:\code\genzoroom\.tmp\lightcraft-a5-p0\target\release\lightcraft-cli.genzoroom.json`（beforeContract=1／previewContract=1、本家commit・patch digest・binary SHAを照合済み）。旧GPU PoCのEXEは操作せず、既存`.tmp/lightcraft-a2`のEXEも旧SHA `b0fbade4ab598614e03af4c29fecfe0a3f0f000642072d602495ae8b15d78aeb`を維持している。

限定確認で、mode/budget切替のclearをsource取得前へ移し、見積り用Plan計算のpanic guardを補強した。native source／decoder情報が二重decodeやaccept漏れを起こさないこと、cold cache作成・次回reuse・失敗clearを回帰で確認した。CPUのfinite admission／保守的fallback／post-trimを維持し、この変更境界で未解決High／Mediumはない。新binaryでのWindows実RAW速度・画質・RSS/VRAM・長時間評価は未実施。ユーザーがEXE設定を上記pathへ切り替え、まず同じDNGのCPU／512 MiB／1024pxでA4を再測定する。P0だけで停止し、P1および工程B・Cへ進まない。

<a id="raw-preview-a5-p1"></a>

## 18. A5-P1：連続ドラッグの送信・Draft採用（2026-10-24）

基準HEAD `62798c2`、LightCraft v0.10.0＋A5-P0。§13〜15のdesired入力で表示を失効させる規約は、本節の限定されたACK暫定表示で更新する。解像度・native patch・API／Recipe／History schemaは変更しない。

### 18.1 P1a：latest-wins bounded throttle

`RawControls`の150ms trailing debounceを、最初の未送信入力でarmし、後続入力で延長しない150ms timerへ変更した。pendingは一つのpatchへ上書き集約し、busy／queued中に独立したmutationを積まない。通常gestureは一ACKでowner queueを解放し、次patchはACK後150ms以上空ける。150msは既存値を基準として最大約6.7試行/秒に抑え、P1で周期最適化まで広げないための選択である。

ACK後のAfter表示slotが動作中なら150ms刻みで送信を譲る。courtesyはACKから1000ms未満の間だけであり、timer丸めを含め約1050msで次mutationを許可する（event loop・owner queue・実native処理の待機時間は別）。これにより速いmutationが遅いrenderのnative revisionを直ちに変更することを避ける。一方、転送／decode停止は無期限の編集停止にしない。save／gesture endの既存flushはcourtesyを迂回し、既にbusyのactionにもdrainを伝えてsave barrierより前に最終patchを処理する。画像完了をsaveの依存へ加えない。

200 soft thresholdでholdする既存規約と256 hard limitは維持。持続ドラッグでも送信が増えるので、最速条件では約30秒で200に近づき得る。最終flushの予約枠とSession再生成を残す。revision conflictの一回readback再同期だけは従来の有限retryを維持し、結果不明mutationは自動再送しない。

### 18.2 P1b：ACKに限定した暫定表示

| 状態 | 所有者・意味・採用条件 |
| --- | --- |
| desired／pending | RawControlsの未確認UI意図。一つのlatest patch。描画・保存の正本にはしない。 |
| confirmed revision | native readbackによるACKだけで更新。preview callbackはpendingの有無にかかわらずACKを渡す。 |
| mutating | RawControlsの送信〜ACK/readback区間。新mutation中は以前のDraftを採用しない。 |
| native revision | rawPreviewの応答identity／revision検査とdecode後readRawDocumentで照合。confirmedが同じでもnativeが進んだ画像は採用しない。 |
| displayRunning／displayPending | hookの一実行＋一latest待機slot。ACKは待機slotを置換し、desired更新だけでは実行中Draftをcancelしない。 |
| document／generation／token／view | installed editor、asset、effect serial、generation、documentToken、viewGeneration、displayGenerationを照合。view切替、gesture終了、保存停止、離脱、再生成はcancel／失効境界を維持。 |
| displayedRevision | document install時に初期化するhook内の表示下限。採用直前に比較して同document内のrevision逆行を防ぐ。 |

暫定表示を許すのはinteracting中のACK済みrevisionだけ。最新desiredより遅れていても、上記のnative／ownership／view検査に合格すれば採用する。bitmap公開でdocument／settingsを上書きせず、UIのpending／desiredは別に保つ。新ACKが来れば古いrevisionは不適格。終了時はDraftを失効させ、最終flush→同owner queueのHistory receipt後に最新confirmedのFullを要求する。同revisionでもqualityが異なればFullを再発行する。Full失敗は既存displayErrorで表示し、保存成功を取り消さない。

### 18.3 計測・検証・実機境界

`interaction.summary`（debug）はgeneration／gestureIdごとの固定サイズ集計。入力・送信・ACK・Draft送信要求／採用数、revision／generation／session／view／departure／ended／frozen／superseded／failed別棄却数、入力→ACK最大ms、ACK→Draft採用最大ms、終了→Full採用msを記録する。入力時刻は送信patchへ集約された最後の入力の時刻であり、全pointerの分布ではない。Draft要求は実行slotからHTTPへ送った数、採用はdecodeとnative照合後にhook表示状態へ公開した数。待機slotの集約は送信要求数へ含めない。ended時のsummaryは途中値であり、fullDisplayedまたはnextGesture／disposedのsummaryを参照する。レコード列／画像／設定本文は保持しない。ログ失敗は編集に影響させない。

通常編集のStageCacheは既存の `GENZOROOM_RAW_STAGE_CACHE=on` と `GENZOROOM_RAW_STAGE_CACHE_BUDGET_BYTES=536870912` を引き続き使用できる。環境変数→native引数の512MiB回帰を追加。無指定はoff、有限予算・fallbackは既存どおり。P0実測のWarm短縮は固定settingsの結果であり、P1連続操作の速度保証へ転用しない。

自動試験の比較・件数・制約は[性能記録§11](RAW_PREVIEW_INTERACTION_PERFORMANCE.md#a5-p1)を参照。Windows実RAW／CPU・GPU／WebViewの表示頻度・操作感・画質・RSS/VRAMは未測定。工程B・C、解像度変更、History UIの別件修正は対象外。

## 19. A5-P2：GPU capacityと事前予算判定（2026-10-24）

調査Commit `db63015`を基準に実装した。履歴上のGPU／mixed一律見積りは、実sourceとPlanを取得できる場合に限り本節で更新する。式・所有権・診断契約・検証・binary SHAは[DX12調査§12](RAW_DX12_STAGE_CACHE_RESEARCH.md#12-a5-p2実装結果2026-10-24)を正本とする。

GPUはBuf.lenを論理長、raw().size()を実capacityとして区別し、全sideのallocation identityで重複除外する。CPU sourceはVec capacityで計量し、CPU/GPU entryの同じhost Arcを一度だけ課金する。StagePoolのcpuBytes/gpuBytesはtrim前capacity、retainedBytesはtrim後で、RSS／OS VRAMではない。

GPU/mixed admissionは既存host/device capacity＋未計上source＋今回GPU追加量（最大plane32P、sampled/lin miss各12P、pool余剰25%）＋CPU fallbackのP0追加量を予約する。小source uploadはsideごと、大sourceは別所有の既存shared＋新uploadをadmissionに含める。旧entryのevictionを先取りしない。不明／overflowは旧保守式または拒否、CPU確定経路はP0を維持する。post-trimだけでallocation前の拒否を緩和しない。

adaptive previewにoptional execution（gpu_success／cpu_not_tried／cpu_fallback、backend、固定reason）を追加した。gpu_successはreadback・error scope・出力検証後に確定し、hybridの全stage GPUを意味しない。Backend構造化ログとA4へ同じ結果を伝播し、旧metadata／旧A4記録も受け入れる。process-wide lastFallbackを個別成功判定へ流用しない。

MCP 59＋e2e10、GPU/Engine/CPUの関連回帰、Backend116、Frontend診断30と型検査／build、clean再適用、release EXE／receipt／SHA照合に成功。実binary DX12合成probeは1024px／512 MiB適用・Full一致を確認した。実RAW性能・RSS/VRAM・driver device lossはユーザー実機確認が必要。P1/C4／解像度／工程B/Cは変更しない。
