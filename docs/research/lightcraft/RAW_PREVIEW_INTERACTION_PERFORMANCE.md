# RAWプレビューの追従遅延とStageCache不適用：A5調査

調査日：2026-10-24。基準HEAD：`e0688f9c50366f1acb3722309fb818a9cf3a2587`、branch：`feature/lightcraft-integration`。開始時の作業ツリーはclean。調査・文書化だけを行い、製品コード、管理patch、binary、API、SQLite v8、JPEG Recipe v18、C4保存・History契約は変更しない。

§1〜9はA5調査時点の旧binaryに対する記録。後続A5-P0のCPU admission実装と追加実測資料は§10、P1のドラッグ追従実装・模擬検証は§11が現行記録。

## 1. 結論と根拠の確度

| 現象 | 結論 | 確度・残る確認 |
| --- | --- | --- |
| 1024px／512 MiBのONが全件不適用 | 管理patchの事前見積りが、出力項だけで512 MiB、source項込みで最低737 MiBになる。空のCPU cacheでも必ず予算拒否される。不要判定ではない | **コードから確定**。実機JSONのreason／binary SHAは今回提供されていないため、その実行が同一binaryでreason=budgetだったことはJSONで照合する |
| DraftがFullより約2〜3%遅い | Draftは一律の低解像度／軽量現像ではない。固定settings・1024px・StageCache無効では主要な差分が発生しない条件がある。3回の中央値だけでは逆転の有意性や内訳を確定できない | 品質の意味は**確定**。当該DNGの有効tone/HDR/NR、処理内訳、ばらつきは**未確認** |
| ドラッグ時の間欠更新 | 150ms trailing debounceによる送信機会の減少と、pendingが尽きるまでDraftを出さず、新入力ごとに進行中結果を失効させる採用条件が、連続入力に不利 | 待機・失効条件は**確定**。観測された更新周期のうち各要因が占める時間は**未計測**。同期native処理も下限を作る |

最小変更で検証する第一候補は、**CPU経路に限ったStageCache事前予算見積りの適正化**。既存A4を変更せず、同じ512 MiB・1024pxで実適用・保持量・Full一致・時間を比較できる。ただし、これだけで連続ドラッグの送信／採用機会が回復するとは言わない。ドラッグ追従の候補は§6の別段階として扱う。今回いずれも実装しない。

## 2. 調査対象・証拠・A4実測の扱い

主要資料：[適応型設計§13〜16](RAW_ADAPTIVE_PREVIEW_DESIGN.md)、[解像度調査§12〜15](RAW_RENDER_RESOLUTION_RESEARCH.md)、[architecture](../../architecture.md)、[更新手順](UPDATE_GUIDE.md)。工程別の旧未実装記録は現行A3/A4の実装記録と区別した。

追跡したGenzoRoomコード：

- [AdjustmentSlider](../../../frontend/src/AdjustmentSlider.tsx)、[RawAdjustmentControls](../../../frontend/src/RawAdjustmentControls.tsx)、[RawControls](../../../frontend/src/rawControls.ts)、[RawRecipeSave](../../../frontend/src/rawRecipeSave.ts)、[useRawDocument](../../../frontend/src/useRawDocument.ts)、[rawApi](../../../frontend/src/rawApi.ts)。
- [Windows RAW API](../../../backend/windows_raw_api.py)、[native RAW owner](../../../backend/lightcraft_raw.py)、[manager](../../../backend/lightcraft_runtime.py)、[MCP transport](../../../backend/lightcraft_mcp.py)、[A4 driver](../../../backend/raw_diagnostics.py)、[A4 Frontend集計](../../../frontend/src/rawDiagnostics.ts)。
- [管理manifest](../../../native/lightcraft/manifest.json)と[管理patch](../../../native/lightcraft/patches/0001-native-before.patch)。patch実ファイルのSHA-256はmanifestの`3ac3bab2e024d1226ffe536a2325959d228635558e0fdcfafb1c84fd1e5eba70`と一致。

既存checkout `.tmp/lightcraft-a2`のHEADが固定upstream `a2a41383c4fd62fa85a46ccd00998639221f2d3c`であることを確認し、管理patchに加えて次のnative実装を静的参照した。checkoutは再現可能な補助参照であり、成果物や新しい依存ではない。

| nativeファイル／symbol | 確認内容 |
| --- | --- |
| `crates/mcp/src/preview.rs::StagePool::{prepare,sizes,finish}`（管理patch L556〜642） | 予算式・clear・計量・fallback理由 |
| `crates/mcp/src/headless.rs::adaptive_render`（patch L247付近） | 元寸法を見積りへ渡し、job.draft／with_stages／run／acceptを実行 |
| `crates/engine/src/media.rs::RenderJob::{draft,run_photo,with_stages}`、`Session::build_job`、`SourceLevel` | quality変更とsource取得・cacheの独立性 |
| `crates/pipeline/src/lib.rs::StageCache::{count_bytes,get,put}`、`render_impl`、`hdr_histogram`、`Plan` | retention、再利用key、CPUのDraft NR近似、HDR追加描画 |
| `crates/pipeline/src/local.rs::{plane_sigmas,Planes::for_other_nr}` | tone sigma制限とNR近似のFull非採用 |
| `crates/gpu/src/render.rs::GpuStages::{bytes,host_source_bytes}`、`prepare`、`crates/gpu/src/lib.rs::stage_*bytes` | device／host計量と共通sigma |

ユーザー報告は、CPU、Pixel 7 Pro DNG、1024×770、512 MiB、各3回。ONは全試行applied=false、retained=0 B。OFFのNative中央値は次のとおり。

| 条件 | Draft | Full | Draft÷Full |
| --- | ---: | ---: | ---: |
| Cold | 819.57ms | 802.37ms | 1.0214（Draftが約2.14%長い） |
| Warm | 95.33ms | 92.36ms | 1.0322（約3.22%長い） |

これは報告値の解釈であり、こちらで実行した性能試験ではない。元JSON、各試行値、実RAW寸法、settings fingerprint、実機binary receipt／SHA、通常暗室のcache/GPU環境は受領していない。機種名や出力寸法からセンサー／RAW寸法を正本として推定しない。

## 3. StageCacheが適用されない理由

### 3.1 ON指定・単位とnative到達

UIの512 MiBは`512 * 1024**2 = 536,870,912 bytes`。A4 `RawDiagnosticsApi._prepare`が診断Sessionへ`stage_cache="on", stage_cache_budget_bytes=536870912`を渡す。通常編集の環境変数とは独立した明示設定で、環境を書き換えたふりはしていない。

`LightCraftRawSession._previews` → manager `_raw_preview` → MCP `render_preview`へ`quality, preview_contract=1, stage_cache, stage_cache_budget_bytes`が渡る。管理patchのtools→headless転送と`Options::parse`は正整数byte値を維持する。nativeは`memory::budget()`を超える要求をエラーにし、GenzoRoomはimport時の`app.memoryBudget {mb:1024}`を1 GiBとして照合する。MiB/MBの1000倍換算ミスではない。

Backendは返却metadataのmodeとON budgetがSession設定と一致することも検査する。既存A4テストはfake MCPへの品質・cache・budget引数を確認する。ただしfakeや32px syntheticの成功は、1024pxの事前式が実用的なことを証明していなかった。

### 3.2 数式で確定する拒否

現行`StagePool::prepare`は、CPU/GPUに関係なく次の見積りを使う（演算overflowも拒否）。

```text
E = edge² × 512 + max(originalWidth × originalHeight, 2560²) × 36
admit iff E + currentCpuBytes + currentGpuBytes <= requestedBudget
```

`edge`はMCPからの要求long edge=1024。1024×770の実bitmap面積ではなく1024²を使う。`original`はcatalog photoの元寸法であり、実際にcacheがpinするdecoded sourceの寸法とは限らない。

| 1024px・空poolでの項目 | 見積り |
| --- | ---: |
| 出力項 `1024² × 512` | 512 MiB |
| source項の最低値 `2560² × 36` | 225 MiB |
| 最低合計 | **737 MiB**（772,800,512 bytes） |
| 例：original=4032×3024 | 930.605 MiB |
| 例：original=4080×3072 | 942.313 MiB |
| 例：originalが50,000,000画素 | 2,228.614 MiB（1 GiBでも不可） |

例のRAW寸法は当該DNGの実寸と認定していない。どの元寸法でも最低737 MiBなので、512 MiBでは空poolの最初のONさえ通らない。処理はstagesなしにfallbackし、`finish`は`mode:on, applied:false, reason:budget`を生成する。poolが空のままならcpu/gpu/retainedはすべて0。**cacheが不要な画像を検出した結果ではなく、保守的な予算ガードが実用条件を拒否している**。上限を無制限に増やす解決は採用しない。

実機JSONにreason=budgetと536870912があるか、LC versionだけでなくbinarySha256が管理buildと一致するかは最終照合点。別reason／別binaryならこのコードによる説明をそのまま適用しない。

### 3.3 保守性と二重計上

1. 出力512 bytes/pixelは2サイズのCPU+GPU planes等をまとめた安全側の係数。CPU-onlyにも同じ係数を使い、実bitmap面積も使わない。
2. source項は最低2560²、元RAWが大きければ元画素数×36。しかし通常の非大cropな1024出力では`SourceLevel::Preview`（long edge≤2560）が選ばれ、StageCacheの`src`はその縮小RGB32fである。Draft/Fullどちらも同じsource選択。元DNGのdecode中間メモリは別問題で、stage retentionへ原寸を常に加える根拠にはならない。
3. 既存cacheを再利用する要求でも、**既存総保持量＋新規最大見積り一式**を毎回要求する。現在のbufferをそのまま再利用できても増分0として扱わない。高budgetで初回だけ適用し、次回は既存量込みで拒否・current slot破棄、という可能性もある。今回512 MiBでは初回から拒否なので、この二次要因が実測されたとは言わない。
4. CPU `retained_bytes()`は同StageCache内のArc参照を一度だけ数える。GPU device bytesも同GPU cache内では重複除外する。一方poolのAfter/Before間、CPU retentionとGPU host source間、通常source cacheとの間は全体でdeduplicateしない。同じhost Arcでも各ownerへ保守的課金する。これは物理メモリの複製を意味しない。hostとdeviceが本当に別allocationなら、その2つは二重計上として除去してはいけない。
5. source pinの課金自体は必要。通常source cacheのeviction後もStageCacheがArcを保持できるため、単にsource分を全部ゼロにすると保持量を過少評価する。retained budgetはprocess RSS／一時working set／driver poolのhard capではない。

### 3.4 実保持量の条件付き推定

CPU cache entryの主要bufferは、sampled RGB32f=12P、lin RGB32f=12P、log luminance=4P。必要ならbase/clarity/texture/dark各4P、chroma RGB32f=12P。従って主bufferは約28P〜56P/entry＋pinするsource `12S`（不要plane・aliasで減る）。これはallocator等を含むRSS見積りではない。

P=1024×770、S=2560×1925を**仮定**すると、1 entry＋sourceは約77.45〜98.51 MiB。1 sourceが2560²以下で2 entryとも同sourceを共有する条件なら、2 entry最大plane＋sourceは約159.22 MiB。一般的な上限保証ではなく、CPUの512 MiB全拒否が過度に保守的であることを説明する試算。異なるsource Arc、Full sourceを必要とするcrop、source再decode、GPU併用、Before/After双方では別計量が必要。

同じ出力サイズ／frame／sourceなら、DraftとFullはqualityだけで別entryを増やすわけではない。StageCacheのgeoとsource Arcがentryを識別し、lin／planeは個別keyで再計算する。容量2は「必ず2面分を同時新規確保する」という意味ではない。

### 3.5 作成・保持・clearとCold/Warm

ONかつ予算判定通過時だけ`Arc<StageCache>`を作成／再利用して`job.with_stages`する。source／photo、signature（crop/orientation/optics/geometry/profile、Before baseline）、実geometryの変化、budget/mode、library lifecycle／memory budget、render失敗で失効・clearする。通常の同photo選択とmemory queryでは消さない。tone/color/WB等は一律pool破棄ではなく、pipelineの依存keyでsampled／lin／planesの再利用範囲が変わる。描画後はAfter/Before総量を計量し、超過なら非使用side→使用sideの順に破棄する。

`cpuBytes/gpuBytes`はtrim前、`retainedBytes`はtrim後。`applied=true`はjobへstagesを渡したことで、cache hitや描画後も保持できたことの証拠ではない。適用＋retained>0＋次回の再利用・時間／Full一致を分けて確認する。

A4 Coldは各試行で新process／再importするので、試行間StageCache reuseは意図的にない。Warmはcache/quality/temperature groupごとの新processに同条件の非計測描画を一度実行し、その後の3回は同process／source／cacheを使う。group間のDraft→Full共有は測らないが、**Warm group内のreuseは可能**。全ON拒否をprocess再生成だけでは説明できず、512 MiB事前式が十分な原因になる。OFFでもSession source cacheは維持される。

## 4. Draft／Fullの時間差の分析

`RenderJob::draft()`はrequest.qualityをDraftにしてjob keyを変える。source level、max_w/max_h、settings、PNG encode方式を下げない。今回、両方とも1024pxの同じnative経路で描画される。

| Draftの効果 | 今回との差が小さくなる条件／限界 |
| --- | --- |
| tone base sigmaを最大24に制限 | highlights/shadows等が有効な場合だけ。大crop等のない1024pxなら通常sigma=0.015×1024=15.36で、Fullも24未満。空間処理の差がない。実crop／effective settingsはJSON等で別途確認 |
| NR変更中、pre-NR key一致の広域planesを近似reuse | CPU `render_impl`の既存StageCacheが必要。今回はON拒否／OFFで、かつsettings固定なのでNR変更を再現しない。通常NRそのものを一律OFFにはしない |
| HDR histogram用の追加renderを省略 | HDR有効時だけ。SDR固定設定なら差がなく、通常histogram・出力renderは残る。HDR DNG形式というだけでeffective HDR enabledとは断定できない |
| GPUのtone処理 | GPUも共通plane_sigmasを使う。CPUのNR plane近似分岐をGPUへそのまま一般化しない。GPU upload、readback、hybrid/fallback、shader warmupの内訳は未計測 |

既存native回帰`stage_cache_matches_uncached_render_through_a_slider_session`、`drafts_keep_wide_planes_across_a_noise_reduction_change_and_full_renders_do_not`は、NR Draft近似と最後のFull正確性を検査する。A5では本文を静的参照しただけで再実行していない。

CPU source取得は両品質で共通。最初のrenderは未decodeならsourceをloadし、`session.accept`がdecoded sourceをcacheへ受け入れる。Warmの事前描画後はsourceが温まり、StageCache OFFでも再decodeを回避できる。今回Cold/Warm差が大きいことはこの構造と整合するが、約700ms全てをRAW decode時間と認定できない。Coldの起動／import自体はA4 prepare側で計測外、render内decode・初回ライブラリ／CPU warmup等がNativeに入る。OS cacheはflushしていない。

今回のNativeはrender（source取得・現像・encode）＋MCP応答／temp cleanup＋render後settings readback。PNG validation、Full SHA hash、Frontend decodeはNative外。A4のrender前後GPU状態照会やsettings事前確認はTotal側に含む。**PNG encode／MCP／readbackが差を埋めている可能性はあるが、それぞれの実測内訳がないため支配的とは確定できない。**

Draft自体が固有の追加decodeをするコードはない。共有cache下では、前のFullと異なるsigmaのplaneをDraftが作り直す等、cache状態による一時的逆転はあり得るが、今回cache無効の逆転をそのせいとは言わない。固定処理がほぼ同じなら、実行順、CPU周波数／負荷、allocator、PNG内容の違い、計測ゆらぎ等で2〜3%程度の逆転も起こり得る。A4はOFF→ON、Draft→Full等の固定順で、3回中央値だけから統計的優劣・常時高速性を結論しない。

**A4は固定import settingsの反復描画器であり、連続mutation、cache invalidation、入力→ACK、ドラッグの表示採否を再現しない。** 今回のWarm約95msも通常暗室のend-to-end追従時間やFPS保証には換算しない。通常暗室は既定cache off、GPU設定は通常managerの設定であり、A4のCPU／ONを選んでも通常編集へ設定が引き継がれるわけではない。

## 5. ドラッグ入力からViewerまでの実経路

### 5.1 確認できた処理順

| 段階 | 現行の処理・待機条件 |
| --- | --- |
| pointer開始／値更新 | rangeのpointerdown→onBegin→saver.begin→controls.beginPreview。値はnative range onChange（React経由）→RawAdjustmentControls→saver.change→controls.change。独自pointermoveごとのnative送信ではない。desired/pendingとUI値が直ちに更新される |
| 150ms | `RawControls.change`ごとにserial増加、表示invalidate、既存timer clear→150msでflushを再予約。**trailing debounce**であり、150ms周期throttleではない |
| mutation発行 | flushはbusy/queued/hold等を検査して既存enqueueへ一件登録。開始後はpendingを切り離してcontrols POST。処理中の入力は最新patchへ集約し、ACK後のwhileで次patchを送る。ここでは毎回150ms待ち直さない |
| ACK | Frontend module-level owner queue→Windows APIの制御admission／lock→native operation lock→library.select→develop.set→develop.get readback。確認値を採用し、revision／attemptを更新。未知の送信結果を無条件再送しない |
| Draft要求 | ACK後pendingが空のときだけpreview callback。hookもdesired/pendingが空であることを要求。interactingならDraft。入力更新ごとの描画要求ではない |
| 表示scheduler | hookの一つのdisplayRunning＋最新displayPending。品質を含むkeyで集約。新input/begin/view変更はdisplayGenerationを増やし、pending破棄、進行中serialへbest-effort cancel。callbackのcontrol serialも一致必須 |
| Backend render | HTTP admission lockはticket登録と採否時だけ。native workerはcontrol予約／operationを優先、Afterの最新pending→Before。native lock内で同期renderとreadback、解放後にowned PNG validation。送信済みjobは採用失効しても回収する |
| HTTP／decode | PNG転送・body read→Image.decode→valid再確認→readRawDocumentでengine identity再確認→valid再確認→Blob URL交換→React Viewer反映。decodeまで終わっても新inputで破棄され得る |
| 操作終了 | pointerup/cancel/lostcapture→saver.end→endPreview（未送信Draft失効）→save前flush→同owner queueのHistory保存→ACK後refreshPreview。Fullはsave locked中にpumpせず、保存終了通知で発行可能。同revisionでもqualityを含むkeyでFullを再要求する |

keyboard／wheelのgesture確定はAdjustmentSliderの別の500ms inactivity timer。各changeは同じRAW 150ms debounceを通る。数値入力もbegin/changeとEnter／blur等のcommitに分かれる。150msと500msを同じ待機として足し合わせたり、pointer中も500msで定期commitすると解釈しない。

### 5.2 連続入力で失われる機会

**idleから16ms間隔でchangeが来る例**：t=0に150msを予約→t=16に166msへ延長→以後も延長。外部flushがなければ、入力が止まるまでnative mutationは始まらない。pointerup時はsave前flushで待機timerを打ち切る。ユーザーが150ms以上止まる／イベント間隔が開くとその途中でも送信される。従って「ドラッグ中も時々更新」という報告と矛盾しない。ただし実際のイベント間隔を測っていないため、それが全ての更新を説明するとは断定しない。

一度flushが走った後は別の飢餓条件がある。ACKごとにpendingが残ればwhileで最新mutationへ進み、中間ACKのDraftを出さない。pendingが一瞬空になりDraftを発行しても、次の入力でserial／displayGenerationを失効させる。新しい値がまだnativeへ送られていなくても、古いACKに対応した画像の表示資格を失う。render完了／decodeより入力が速い間、計算が行われてもViewerへ採用されない。

単純なthrottle置換だけでは、後者は解消しない。送信開始が早まりmutationは増えても、control優先でDraftが未送信のまま置換される／送信済みが失効することがある。公平な描画機会と「最新desiredより少し前の確認済みrevisionを暫定表示してよいか」を別途決める必要がある。現在は厳しいfreshnessを優先した契約である。

### 5.3 主要因の順位と未確定の寄与

| 要因 | 判断 |
| --- | --- |
| 入力集約・採用条件 | **第一の構造要因**。待機とstarvationをコードだけで示せる。送信回数／採用回数の実機counterで寄与を確定する |
| 同期native処理 | **必須の時間下限**。native lockと`LightCraftMCP.request`のlockは応答まで保持、headless serverも同期処理。実行中Full/Draftを新inputがpreemptできない。Warm約95ms＋mutation／readback／転送等なので毎pointer event追従は期待できない |
| scheduler／control reservation | **増幅要因**。制御要求はHTTP受付時から完了までnative render開始を抑える。連続mutationやHistory read/saveが続けば未送信Draftが待つ。送信済みnativeの回収責任は維持が必要 |
| History保存／owner queue | ドラッグ途中に毎入力SQLite保存する構造ではない。gesture終了・handoff・History操作／再生成時のfenceと競合し、最終Fullの開始を遅らせ得る。定常ドラッグの主因をSQLiteと断定する根拠はない |
| PNG／HTTP／decode／表示前document再確認 | 必ず通る追加遅延。displayRunningはこの区間まで次要求を待つ。新入力で成果が破棄される窓も長くなる。数値未提供なので支配割合は未確定 |
| StageCache無効 | source cache以外の再利用を得られずnative計算を増やし得る。通常暗室のON設定の有無とreasonの取得が先。A4 ON拒否が通常編集での設定を示すわけではない |

### 5.4 200／256試行との関係

native `_mutate`は送信mutation試行を数え、失敗／readback失敗でも無制限Historyを許さない。通常set_controlsは一patchにつきdevelop.set一回（select/query/renderはこのmutation回数ではない）。複合Reset等は複数native commandを消費し得る。

hookはgesture中に200 soft thresholdへ達するとcontrolsのholdで未送信最新patchを保持し、中間mutationを止める。終了時save operationに入るとholdを外して最終値flush・History保存、その後同Session再生成へ進む。hard limitは256。高速化でmutationを増やすほどsoft threshold到達が早まり、長いgesture後半の意図的な更新停止が増える。観測された全間欠更新をこの上限で説明せず、当該時点のmutationAttempts／regenerationログを確認する。

## 6. 改善案・優先順位（すべて未実装）

| 優先・候補 | 期待効果／変更範囲 | C4・mutation回数 | 資源・リスク／必要な測定 |
| --- | --- | --- | --- |
| **P0：CPUのStageCache admissionを適正化** | 管理patchのprepare／計量helperと回帰に限定。CPU-onlyでは実source level／寸法と必要plane／entry容量を根拠に有限見積り。CPU/GPU混在は従来安全側を維持する段階案 | settings／保存／Historyは変更不要、mutation回数も不変。Full一致は必須 | retainedは増えるが512 MiB等の上限は維持。実decoded sourceの情報取得位置、追加確保上界、trimを検証。A4で適用率・保持・Full一致・Native比較。**単に係数を小さくする修正は不可** |
| P1a：送信機会を保証するbounded throttle/latest-wins | RawControlsの最初の未送信入力でtimerをarmし、以後延長しない／max-waitを設ける。busy中は既存pendingへ集約し独立queueを増やさない | gesture begin/end、save前flush、未知結果の再送規則を維持。mutation増、200到達が早まる。busy whileも発行間隔の対象にしないと上限をすり抜ける | input→ACKを短縮し得るが表示飢餓は残る。固定150msから始めても最終周期は実測判断。mutation/s・200到達時間・ACK率を測る |
| P1b：P1aと合わせてACKベースの暫定表示機会を設ける | rawControls／hook既存display slotの条件を限定変更。desired更新だけでは有効なACK画像を一律失効させず、次mutation／revision、写真・generation・view境界と区別。ACKごとの無制限描画ではなく最新slotと発行間隔で集約 | これはA1/A3の「新desiredで採用失効」を緩める仕様変更。暫定の遅れをUI状態と区別し、保存する値は常に最終確認値。native revisionが変わった結果を無条件採用しない | 表示採用率改善の可能性。mutationがrenderより速いとBackend revision検査でも棄却されるため、既存coordinatorでmutation/renderの公平な機会を検討。画像完了をsave成功条件へ戻してはいけない。入力→表示age、採用率、最終Fullを測る |
| P2：StageCacheの増分admission／reuse強化 | 同slot再利用を全新規扱いせず、置換／追加allocationの上界を算定。必要なら非使用sideを先にevict。既存native細分keyを使う | 保存形式・mutation回数に影響なし。Before/After独立性・Full正確性を維持 | current＋full reserveの二重保守性を減らす。source Arc共有は所有権を追って課金し、global cache基盤は作らない。予算境界／mode切替／crop／source変更／fallbackを試験 |
| P2：描画前後・保存の不要な待機を計測して最小修正 | native mutation/readback、画像validate/decode、HTTP表示前readを個別観測し、重複query等が支配的なら削減候補を限定 | readback／History receiptは根拠なく削除不可。送信済みrender回収、control reservationとclose保証を維持 | 今のコードは画像を保存queueから既に分離。単なるawait削除は改善案にしない。同期MCP完全preemptionや複数Session同一編集は今回候補外 |

**第一候補P0の安全設計gate**：予算を増やさず、CPU確定経路だけから着手する。source pinと2 entry上界を扱い、allocation前のchecked見積りと描画後総retention検査を両方残す。estimateが不明なら従来fallbackへ戻す。actual sourceを知るためにdecode前後の接続が必要かを実装前に確認し、geometryからの想像だけで常にPreviewと決めない。post-trimだけでpeakを管理できるとは言わない。修正時はUPDATE_GUIDEどおりpatch digest／実binary receipt／SHA／native回帰を更新する。A5では何も変更しない。

P0は最小の独立実験として優先するが、**追従UX改善の本命はP1a＋P1bの整合した設計**。throttleだけ／stale check削除だけを先行して完成扱いにしない。実装範囲を一度に広げず、下記観測でinput/ACK飢餓かrender時間かを見て次段階を選ぶ。

## 7. C4保存・Historyに対して維持する不変条件

1. confirmedはnative readbackからのみ更新。desired／表示bitmapをRecipeやHistoryの正本にしない。一gestureの最終確認値だけを既存History ownerで確定する。
2. save前に未送信patchをflushし、同owner queueでnative mutation/readback→History保存とreceipt検証を完了する。owner queue内からcontrols.settleを待つ自己deadlockを作らない。
3. 画像PNG検証・転送・decode・Viewer表示を保存成功条件に戻さない。最終Fullは最新保存ACKへ収束し、同revision Draft→Fullも再描画する。
4. HTTP waiter／表示cancelで送信済みMCPをabortしない。native timeout／喪失は既存回収契約を使う。未知のsaveId／mutation結果の無条件再送を増やさない。
5. control reservationはreadbackとdurable receiptの安全fence。短縮するなら保存途中のrenderによるnative変化・identity競合を回帰で防ぐ。同期MCPの既実行Fullが後続操作を待たせる制約は残る。
6. 200/256の保護、gesture handoff、Undo/Redo・History jump・Reset・カテゴリ操作、写真切替・再生成・離脱取消、BeforeとJPEG経路を維持する。

既存テストの参照先：[rawControls.test](../../../frontend/src/rawControls.test.ts)のdebounce／latest pending／render invalidate、[useRawDocument.test](../../../frontend/src/useRawDocument.test.tsx)のDraft→Full／decode停止中保存／再生成、[rawRecipeSave.test](../../../frontend/src/rawRecipeSave.test.ts)、[Windows RAW API tests](../../../backend/tests/test_windows_raw_api.py)、[native owner tests](../../../backend/tests/test_lightcraft_raw.py)、[A4 tests](../../../backend/tests/test_raw_diagnostics.py)。今回は静的な本文確認であり、実行済み結果を追加報告していない。

## 8. 追加測定・受入条件

### 8.1 既存A4だけで確認できること

- 元JSONのcontract/binary SHA、CPU確認、ON budget、reason、trim前CPU/GPU・trim後retained、個別値／中央値／min/maxを回収する。今回reason未提示なので最初に確認する。
- P0修正前後で同じRAW／512 MiB／1024／CPUを測定。修正前の不適用をbaselineとし、修正後Warmで実適用と保持・時間を比較。cacheが適用されたFull OFF/ONだけ一致を評価する。現行全拒否では「ONが効果なし」ではなく「ONの効果未測定」。
- 小budgetで明示fallback、finite budget内保持、ColdとWarmの区別を確認。GPUは別runとし、設定値だけで成功扱いしない。
- A4だけではsettings変更時のstage reuse、通常編集のHistory競合、input→display、Draft採用率、NR変更後の最終Fullは検証できない。

### 8.2 最小限の観測追加案

既存debugログの`raw.controls.confirmed`（generation/revision）、`preview.measured`（Native/validation/cache）、`preview.completed`、`raw.preview.complete`、Frontend `preview.received`（responseWait/body read）、`preview.decoded`、`history.saved`、再生成開始／終了をまず利用する。BackendとFrontend時計の絶対差を引かず、同じ時計のdurationとidentityで区間を対応させる。現状ログだけでは入力時刻／正確なpublish／全棄却理由を復元できない。

必要な追加は既存loggerへのboundedなgesture集計と境界timestampで十分。新しい独立測定queueや永続cache基盤は不要。

| 観測点 | 安全な項目と用途 |
| --- | --- |
| gesture start／change集約／end | transient gestureId、入力count、最初／最新input時刻、desired serial。毎pointer eventを無制限記録せず集計。settings本文や無制限の値列は記録しない |
| mutation dispatch／ACK | serial、generation/revision、queue wait／ACK ms、試行数。input→ACKとbusy loop消費を区別 |
| Draft/Full intent／送信／採用／棄却 | renderSerial、revision、quality、viewGeneration、reason（desired/revision/replaced/departure等）、各countと表示age。decode成功をpublish成功と数えない |
| gesture end→Full publish | 同時計のelapsed、最終ACK revision／quality、save開始／ACKと照合。画像待機をsaveへ混入しない |
| cache admission（nativeを修正する場合） | CPU/GPU設定、estimate、既存量、required追加量、source level／寸法、拒否reason、retained。path／buffer／settingsを出さない |

連続調整の再現は、一定間隔・有限回数のexposure／WB／highlights等を既存controls経路へ送り、通常暗室ではC4の一gestureとして扱う。必要ならA4専用Sessionでdevelop.set＋getを実行する限定系列を別ケースに追加するが、その場合も診断素材のRecipe／History／Immich保存はしない。通常暗室のschedulerを通る試験とnativeだけの系列を同一結果と呼ばない。NR/HDR等は現在RAW controlsの公開範囲を超えるため、engineの既存試験／診断専用の検証済み設定系列で別に評価し、暗室UIに新controlを作らない。

### 8.3 受入条件（実装時に確認、今回未実施）

1. 同一binary/RAW/settings/frame/Backend/サイズを照合。CPU P0対象では512 MiB以内の実保持を確認し、ON=appliedかつ保持ありの系列を得る。tiny budget、source変化、2 entry、Before/After、mode/budget切替でも上限と回収を維持。
2. 連続入力を150ms未満の間隔で数秒以上継続し、送信と採用count／表示ageを測る。単にmutation数が増えるだけでは合格にしない。P1の暫定表示を採用するなら、同document内の表示revisionが後退せず、許容ageと最終収束を実機結果から決める。
3. 最終入力後のnative ACK、History ACK、Full publishを確認。最終Fullは最新確認revision／quality=full、変更前後のOFF Fullと同条件で一致。CPU同一条件ではPNG SHAを使い、GPU経路差の許容画素差は別検証とする。settings fingerprint一致も確認。
4. 200 soft threshold・256 hard limit、save失敗／retry、handoff／Undo/Redo／Reset／写真切替／終了を回帰。PNG/decodeを故障注入しても保存ACKと送信済みnative回収が維持される。
5. RSS／VRAM peak・長時間・高画素RAWはOSで別計測。StageCache retainedを代用品にしない。負荷／GPU fallback／source evictionがある条件の結果を混ぜず、3回中央値だけで性能保証を作らない。

## 9. 未確認事項・A5終了範囲

未確認：実機JSONのreason／binary SHA、元RAW寸法・effective設定、通常暗室のcache／GPU設定、pointer change間隔、各要求・採用・破棄count、mutation/readback／encode／HTTP／decode／表示前照会の時間、予算修正後の実retentionと速度、画質・RSS/VRAM、長時間・高画素／実GPUの挙動。

今回実施した検証は、現行コード・既存テストの静的調査、固定upstream HEAD／管理patch digest照合、予算と中央値比の算術確認、文書参照と`git diff --check`。新規build、自動テスト再実行、browser操作、実RAW性能試験は行っていない。指定の本調査文書のみを追加し、修正実装および工程B・Cへ進まない。

<a id="cpu-stage-admission-record"></a>

## 10. A5-P0：CPU admission実装と追加実測資料（2026-10-24）

### 10.1 旧binaryの追加実機結果

提供JSON `genzoroom-raw-preview-20261024T020334Z.json`を照合した。旧binary SHA `b0fbade4ab598614e03af4c29fecfe0a3f0f000642072d602495ae8b15d78aeb`、CPU、3990×3000 DNG、1024×770、**1024 MiB budget**の24試行。ONの12件すべてapplied=true／reason=none／retained=84,367,360 bytes／gpuBytes=0、Full off/onの6組すべてSHA一致。Native中央値はDraft Cold OFF/ON=792.06/798.89ms、Full Cold=788.02/793.83ms、Draft Warm=92.79/41.84ms、Full Warm=93.81/40.49ms。

旧binaryでも十分なbudgetならcacheは機能し、Warmで効果を得ている。§1〜9の「元JSON未受領」「ON効果未測定」はこの資料で更新する。512 MiBでは旧式が約922.96 MiBを要求して拒否する点は変わらない。これらはユーザーによる旧EXEの実測であり、新EXEの速度・画質・メモリ保証ではない。

### 10.2 実装した計算とsource所有権

Headless／StagePoolとpipelineの計量補助を管理patch内で変更した。GPU無効かつpoolにGPU device／host source保持がない場合、mode/budget変更を反映してからguard内でsourceを一度取得し、実際の`DecodedSource.image_for`のArc・寸法・Vec容量を得る。同じDecodedSourceをjobへ渡し、coldの`RenderResult.loaded`→`Session.accept`によるsource cache・decoder情報／As Shot学習を維持する。GenzoRoomの製品コード・API・settingsは変更しない。

```text
R = 全side／entryの既存CPU allocationの実capacity合計（同一Arcは一度）
  + 未計上の当該source実capacity × 12 bytes
  + 実Plan出力画素数P × (32 + sampled missなら12 + lin missなら12)
CPU admit iff R <= requestedBudget
```

sampled／linはRGB32fで各12 bytes/pixel。32はlog/base/clarity/texture/darkのscalar 5面とRGB chromaticityの最大32 bytes/pixelで、hitや未使用でも置換余裕を予約する。sampledはsource Arc＋geo一致、linは加えてlin_key一致で再利用を判断する。元RAWの推定寸法ではなく、pinする実sourceの容量を計上する。同sourceを共有する2 entry／After/Beforeもallocation identityで重複除外する。

既存entryをすべて課金してから追加量を予約するため、旧lin／planesと新lin／planesが共存するピークを含む。capacity=2のevictionを先取りして減算しない。1描画で作るentryは一つで、将来の2サイズ分を毎回新規確保する式にはしない。例えばsource=2560×1925、P=1024×770、Vec容量が画素数と同じなら空poolは約98.51 MiB。既存実測と同じbuffer構成でsampled/linを再利用できる場合は約104.52 MiB。512 MiB以内になるが、source／capacity／既存entryが異なれば再計算する。

### 10.3 保護とfallback

全容量の乗算・加算をchecked arithmeticで行う。非対応・必要情報不足・見積り不能は従来の安全側判定へ戻り、従来式もoverflowすれば拒否する。GPU有効、またはGPU device/host bufferが残る混在状態では、旧式`edge²×512 + max(originalPixels,2560²)×36 + existing CPU/GPU`を維持する。Plan計算にもpanic guardを設け、元のRenderJob guard境界を失わない。

mode/budget変更はsource取得前に無効化。source／signature／geometry／library変更、失敗時clear、描画後のAfter/Before総量検査と非使用side→使用sideのtrimを維持する。post-renderのcpuBytes/gpuBytesは従来の保守的owner別計量、retainedBytesはtrim後であり、allocation共有を除いたCPU admission値と同一とは限らない。wire schemaは変更しない。

Rはcacheの保持bufferとその置換時共存分の上界。decode、filter scratch、PNG、allocator、driver pool等を含むRSS／VRAM全体のhard capではない。source decodeは通常のsource owner／native working budgetが扱い、StageCache bufferはadmission後にだけ確保する。共通native予算と有限StageCache予算の双方を維持する。CPU ONでは見積り用Plan計算が一度増え、その費用もNative時間に含むため、性能は新binaryで再測定する。

### 10.4 検証と残す範囲

回帰対象はCPU 1024px／512 MiB、tiny／必要量超過／overflow／不明source、source共有・切替、sampled/lin再利用・置換ピーク、2 entry、Before/After、mode/budget、Full一致、cold source保持、render失敗後clear、GPU/mixedの旧判定。実binary probeにもCPU 1024px要求／512 MiB、反復・Before/After、off/on Full一致・settings不変・mode clearを追加した。

最終の実行結果、再適用・release build・receiptとbinary SHAは[適応型設計§17](RAW_ADAPTIVE_PREVIEW_DESIGN.md#cpu-stage-admission-p0)に記録する。新binaryでのWindows実RAW再測定はユーザーが実施する。P1、工程B・C、GenzoRoom Frontend／Backend動作、C4保存・History、Recipe／DB／API schemaは変更していない。

<a id="a5-p1"></a>

## 11. A5-P1：送信・採用機会の実装記録（2026-10-24）

§1〜9のA5調査、§10のP0履歴を残し、基準HEAD `62798c2`の現行コードを照合してP1a＋P1bを実装した。詳細な状態不変条件は[適応型設計§18](RAW_ADAPTIVE_PREVIEW_DESIGN.md#raw-preview-a5-p1)を参照。

- P1a：150msの非延長timer＋一latest pending patch。通常busy loopは一ACKで解放。ACK後の表示slotへ最大約1050msの有限courtesyを与え、mutationの連続予約でDraftを飢餓させない。初回timer・通常次回timerは150ms、gesture終了・保存flushは即時drain。200／256の保護は変更しない。
- P1b：ACKごとにDraft候補を通知し、interacting中はdesired／pendingが残っていても許可。desired更新だけで実行中Draftを破棄しない。新mutation中、新ACK revision、別document／generation／Session／view、終了・離脱では採用不可。応答検査・decode後native revision照合・表示revision下限を維持。一実行＋一待機slotを越えない。
- C4：confirmedはreadbackのみ。Recipe／Historyの正本、最終patch→ACK→同queue receipt、未知mutation／saveIdの再送規則は不変。saveはPNG・転送・decode・表示を待たない。終了後は最新confirmed Fullを優先し、画像失敗と保存結果を分離する。

### 11.1 模擬連続入力の比較

React DOM＋fake timer／fake APIで50ms間隔の60入力（3秒）を再現。以下は実CPU/GPU／HTTP／画像処理の計測ではなく、設定した遅延に対するschedulerとhook表示状態への採用結果。Fullまでのmutationには最終flushも含む。input→ACKは各送信patchの最後の入力から測る。

| mutation／render遅延 | mutation／ACK | Draft要求／採用 | input→ACK最大 | ACK→Draft採用最大 | 終了→Full採用 |
| --- | --- | --- | --- | --- | --- |
| 10／40ms | 18／18 | 17／17 | 60ms | 40ms | 50ms |
| 10／250ms | 10／10 | 9／8 | 60ms | 250ms | 260ms |
| 300／40ms | 8／8 | 6／6 | 500ms | 40ms | 490ms |

10／250msでは最後のDraft一件が終了境界で棄却され、Fullが優先された。採用revisionは各条件で単調増加、最終Full revisionは最後のconfirmedと一致し、History保存も成功した。追加テストの受入条件は固定した回数そのものではなく、操作中5回以上の採用、逆行防止、最終値Full／保存収束である。

旧150ms trailing debounceでは同じ50ms入力中のtimerが延長されるため、3秒間のmutation／ACK／Draft採用は0（終了時flushは別）。RawControls単体では新方式が同期間20送信機会／20ACK preview callbackを確保する。実際のhookでは表示courtesy・ACK時間で上表へ集約され、mutation増だけを改善成功と判断しない。

### 11.2 検証と制限

FrontendはRAW controls／document／History／save／API／RAW Viewer／Clipboard／ImageViewerを回帰対象とした。追加ケースは連続入力、速い／遅いmutation・render、入力停止と再開、新desired中のDraft decode採用、view変更cancel、停止decodeの有限courtesy、busy中最終flush、Full失敗後の保存成功。既存ケースで未知結果・ACK失敗・200閾値・再生成・Undo/Redo/jump/Reset・写真切替・JPEG・退出・decode停止保存を確認する。

最終関連Frontend 9ファイル398件成功（RAW controls／document／History save／Recipe save／API／RawEditHistory／AnshitsuRawPreview／AnshitsuClipboard／ImageViewer）。先行して周辺AnshitsuPersistenceも含めた10ファイルでは472成功・1失敗で、下記のHEAD再現済み失敗を含む。重複実行の件数は合算しない。TypeScript `tsc --noEmit`を含むproduction buildと`git diff --check`成功。buildの既存500kB超chunk警告は残る。

courtesy判定を壁時計から単調時計へ統一した最終調整後、影響するcontrols／document／History save／Recipe saveの4ファイル108件とbuildを再実行して成功した。変更のない周辺回帰は前記結果を再利用する。

Backendは通常StageCacheの512MiB／1GiB native転送、finite budget拒否、HTTP cancelと送信済みnative回収、revision検証・History・ownerの関連4ファイル149件成功。製品Backend／LightCraft patchは変更しない。sandbox内ではpytest一時領域作成失敗、その後のsandbox内実行は進行停止したため終了し、同じrepository Python 3.14で権限付き実行した。

周辺Frontend回帰の `AnshitsuPersistence.test.tsx`「switches after a successful PUT for a numeric adjustment edit」は0.5を期待して1となり、単独でも基準HEADの製品コードでも同じ失敗を再現した。今回のRAW変更による退行とは判定せず未解決として残す。READMEやJPEG処理の修正へ範囲を広げない。

Windows実機ではP0管理binaryと上記StageCache環境を使い、debugログのgesture別summaryで採用数・棄却理由・遅延を確認する。長いドラッグ／停止再開／終了直後保存／200到達／Before-After／写真切替・離脱・再生成、最終FullのNR・色・細部、cache OFF/ON・CPU/GPU別のRSS/VRAMとfallbackを確認する。ブラウザ操作やスクリーンショット、実RAW速度測定は今回実施していない。60fps・最大表示ageは保証しない。
