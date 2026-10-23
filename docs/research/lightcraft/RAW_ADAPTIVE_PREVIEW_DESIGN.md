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
