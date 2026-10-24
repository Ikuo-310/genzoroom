# A5-P2：DX12 StageCacheの予算・GPUメモリ構造調査

## 1. 調査概要・結論

調査日：2026-10-24。GenzoRoom branch `feature/lightcraft-integration`、開始HEAD `9c41996c78da059ebe66e93d948ce32d45114770`（P1）。P0は`62798c202e31b9954c13b15092533817e10fccbe`。開始時の作業ツリーはclean。今回の変更は本報告書だけで、P2コード実装・binary更新・工程Bには進まない。

以下の表記で根拠を区別する。

- **事実（ログ）**：提供JSONに存在する値。実機の全期間を代表するとは限らない。
- **事実（コード）**：固定upstreamと現行管理patchから確認した処理。
- **推論／設計案**：上記から導く条件付き評価。実機でのallocation計測結果ではない。
- **未確認**：今回の資料・静的解析だけでは確定できない項目。

**結論：** DX12／混在経路の現行admissionは、RAW 3990×3000、edge=1024、空poolでも967,790,912 bytes（922.96 MiB）を要求する。512 MiBでの`reason=budget`は現行コードと整合する。これは実際に922.96 MiBを確保したという意味ではない。実source・Plan・既存allocationを使う改善余地はあるが、現在のGPU保持量計量にもcapacityの過小計量があるため、単純な係数削減は推奨しない。

**判断：** allocation capacityと所有権を明確化し、既存保持＋次回追加量＋置換共存を計算するP2実装は条件付きで可能。512 MiBの常時適用は受入条件にしない。基盤側のshared source／pool／一時allocationを無視して許可する案は不可。

### 参照・再現性

設計履歴：[追従性能調査§10–11](RAW_PREVIEW_INTERACTION_PERFORMANCE.md)、[適応型設計§17–18](RAW_ADAPTIVE_PREVIEW_DESIGN.md)、[解像度調査](RAW_RENDER_RESOLUTION_RESEARCH.md)、[更新手順](UPDATE_GUIDE.md)。管理正本：[patch](../../../native/lightcraft/patches/0001-native-before.patch)、[manifest](../../../native/lightcraft/manifest.json)。

補助checkout `.tmp/lightcraft-a5-p0`を読取り参照した。HEADは固定upstream `a2a41383c4fd62fa85a46ccd00998639221f2d3c`（v0.10.0）。`build.py`の`manifest()`／`source_state()`だけを呼び、patch digestと全source diff一致を確認（結果`patched`）。patch SHA-256は`00a8f1d127c6a04f64fa680f849cdda36c028f8936ed5771afc0d8883655d328`。apply／build／probeは実行していない。

以下のLCパス・行番号はこの照合済みcheckoutのもの。新規依存としてcheckoutを登録する意味ではない。

| 根拠箇所 | 確認内容 |
|---|---|
| `crates/mcp/src/headless.rs:70` `adaptive_render` | source、mode、CPU専用分岐、prepare/run/accept/finish、失敗clear |
| `crates/mcp/src/preview.rs:127` `StagePool` | 2 side、旧式、既存量、trim、metadata |
| `crates/pipeline/src/lib.rs:251` `StageCache` | CPU entry、extension、P0 capacity計算、clear |
| `crates/gpu/src/render.rs:22` `GpuStages` | GPU entry、source、計量、寿命 |
| 同`:462`／`:604`／`:877` | shared source、render、空間plane |
| `crates/gpu/src/ctx.rs:86`／`:378`／`:537` | Buf、再利用capacity、readback |
| `crates/gpu/src/lib.rs` `try_render`／`trim_pool` | fallback、OOM、device loss、外部保持 |
| `crates/engine/src/media.rs:1040`／`:1218` | GPU試行／CPU fallback、source level選択 |

## 2. P1実機ログの解析

**事実（ログ）：** `genzoroom-all-logs-20261024T041149Z.json`、schemaVersion=2、generatedAt=`2026-10-24T04:11:49.604Z`。ファイルSHA-256：`a22c9697802c18b56ed21fed8689afb7f240786f72d8c9cd23cd4079f9db0ff4`。Frontend 22件、Backend 45件。両bufferのdroppedEntryCount=0。ただし起動から全てのイベントがあることを保証する値ではない。

| gesture 487、generation 1 | 結果 |
|---|---|
| inputs／mutations／ACK | 11／8／8 |
| Draft要求／採用 | 8／8、全破棄理由0 |
| inputAckMaxMs／ackDisplayMaxMs | 172.2／126.2 ms |
| ended | 04:11:37.915Z、ここでfullDisplayMs=nullは正常な途中集計 |
| History保存 | 04:11:38.187Z、revision 131、recipeRevision 78、cursor/length=52/52 |
| 最終Full | received 04:11:38.313Z、fullDisplayed summary 04:11:38.326Z、revision 131 |
| 終了→Full表示 | 411 ms（summaryの単調時計値とtimestamp差が整合） |

P1の入力集約・ACKごとのDraft採用・最終保存とFull収束は、このgestureで成功している。前gesture 437の`nextGesture`集計も含まれるため、それを487へ合算しない。

Backend `preview.measured`は9件：After Draft revision 124–131の8件、After Full revision 131の1件。全て1024×770、configuredBackend=dx12、mode=on、budgetBytes=536,870,912、applied=false、reason=budget、cpuBytes/gpuBytes/retainedBytes=0。

| revision | Draft nativeMs |
|---|---:|
| 124 | 81.7870 |
| 125 | 81.1569 |
| 126 | 84.1315 |
| 127 | 78.7624 |
| 128 | 81.9215 |
| 129 | 79.8612 |
| 130 | 81.8653 |
| 131 | 81.8694 |

Full nativeMsは約81.29 ms。Draft validationMsは約22.63–23.63 ms。`backend/lightcraft_raw.py`のnativeMsはnative MCP呼出しの経過時間で、純GPU kernel時間ではなくsource処理・readback・PNG/MCP応答等を含む。CPU P0の固定settings Warm値40.61/41.52 msと、今回の連続操作を比較してCPU/GPUの優劣は判定しない。

**未確認：** この抜粋には各renderの実行backend、source実寸／Vec capacity、GPU allocation、binary SHAを照合する証拠がない。3990×3000は依頼で指定された対象寸法を用いる。以下の922.96 MiBはその入力条件での理論値であり、ログから原本寸法を再発見した値ではない。

## 3. 現行DX12 admission計算

**事実（コード）：** `Options::parse`はon時に正の有限budget（native `memory::budget()`以下）を要求する。headlessのsizeは16–4096へclampされ、`render_job(id,size,size,before,true)`へ渡る。原本寸法はcatalog photoのwidth/height、edgeは要求sizeであり、PNGのwidth×heightではない。

P0の実source計算を使う条件は「budget有効、`!gpu::enabled()`、shutdownでない、poolにGPU host/device保持なし」。`enabled()`は設定・失敗状態等の判定で、adapterの利用可能性や今回GPUを使うかの確約ではない。GPUが有効なままadapter不在／CPU専用処理となった場合も旧式になり得る。GPU保持が残る混在poolも旧式。CPU入力の取得・計算不能は旧式へ戻る。

```text
R = edge² × 512
  + max(originalWidth × originalHeight, 2560²) × 36
  + Σ(sideのCPU retained_bytes + GPU host_source_bytes + GPU stage_bytes)
admit iff checked arithmeticが成功し R <= budget
```

係数512には「2保持サイズ／view、CPU＋GPU plane、host/device sourceを許容する」保守的意図があるが、実allocation一覧との厳密な対応式ではない。全乗加算はchecked。計算不能も拒否する。原本より小さいdecoded sourceを使ってもsource項は原本画素数を使い、出力が横長でもedge²を使う。

| 対象条件（空pool） | bytes | MiB（2²⁰ bytes） |
|---|---:|---:|
| 原本画素数 | 11,970,000 pixels | — |
| edge²×512 | 536,870,912 | 512.0000 |
| max(11,970,000,6,553,600)×36 | 430,920,000 | 410.9573 |
| 合計 | **967,790,912** | **922.9573** |
| budget | 536,870,912 | 512.0000 |

出力項だけでbudget全額を使うため、正のsource項を加えた段階で拒否する。1024×770へ面積だけ置換しても403,701,760＋430,920,000＝834,621,760 bytes（約795.96 MiB）であり、正方形の修正だけでは512 MiBに届かない。

既存量は空でなければさらに加算される。signature不一致で当該sideを捨てた後に計算し、予算拒否では当該slotをNoneにする（他sideは残り得る）。render自体はStageCacheなしで続く。`finish`はonかつ不適用ならbudgetを返す。今回のゼロ値は空poolでの拒否と整合し、GPU演算不実行を示さない。

mode/budgetが変わる、またはoffなら`configure`が両sideをclear。source key変更も両side、signature変更は当該side、geometry変更は当該cacheをclearする。reload、Before基準変更、memory budget変更等もclear対象。render失敗時は両sideをclearする。`finish`は描画後の合計がlimitを超えると非使用side→使用sideの順にslotを捨てる。cpuBytes/gpuBytesはtrim前、retainedBytesはtrim後である。`applied=true`はcacheをjobへ渡した意味で、必ずhitした／最後まで保持された意味ではない。

## 4. GPU buffer／所有権一覧

**事実（コード）：** この現像経路はwgpu storage bufferであり、RGB textureを使う構造ではない。`Planes.texture`はTexture効果用scalar bufferの名称で、`wgpu::Texture`ではない。UI表示textureやブラウザGPUは別所有者・別予算である。

以下でSは実際の`DecodedSource.image_for()`の画素数、Pは実Planのw×h、Mは有効mask数。出力PNG寸法だけからPが常に等しいとはせず、spots/window等の内部拡張をPlanで確認する。

| buffer | 形式・logical bytes | 所在／所有者／寿命 |
|---|---|---|
| decoded source | RGB32f、12S、Vec capacityは別 | CPU。Media/DecodedSourceが所有し、GPU entry.src／小source保持がArcでpin。Before/Afterが同じArcなら物理allocationは一つ |
| uploaded source（小） | 3×f32、12S | GPU。S×12≤96 MiBなら各GpuStages.sourceが保持。After/Beforeは独立uploadになり得る。CPUとGPUの実コピーは別allocation |
| uploaded source（大） | 12S | GPU。96 MiB超はglobal SHARED_SOURCEがWeak CPU source＋Arc Bufで保持。両view共有、StageCache計量外。source不一致の次回使用／trim_pool(0)で解放対象 |
| sampled | RGB32f、12P | GPU。entryに保持、source Arc＋geoで再利用。identity samplingではsource／prefilter結果とのaliasもあり得る |
| linear | RGB32f、12P | GPU。entryにlin_keyと保持、WB/NR等で更新。旧entryが生きている間に新linを確保 |
| log_l、base、clarity、texture、dark | 各f32、各4P | GPU。最大5scalar面をentry保持。base不要時はlog_lとalias。radius・quality・lin_keyで再計算／再利用。以前使ったoptional planeが残る場合もある |
| chroma | RGB32f、12P | GPU。必要時に保持、最大plane合計32P（5scalar＋RGB） |
| orient／prefilter／resize tmp | RGBなら12×対象面積、scalarなら4×面積 | GPU render一時。orientはsource寸法、resize横passはdw×sh×channels×4、縦passはdw×dh×channels×4。出力Pだけでは上限にできない |
| blur／guided intermediate | 1/2/3 channel f32 | GPU render一時。Gaussianは同寸法2bufferのping-pong、guidedは2channel係数や縮小grid等が同時存在。最終planeだけentryへ残る |
| masks／coverage／aux／params | alpha=4P×M＋chroma必要時12P、coverage=4×ceil(w/32)×h、ほか可変 | GPU render一時。mask合成、brush、taps、係数、dispatch params。mask数等に依存し56Pでは覆えない |
| out | packed RGBA8、4P | GPU render一時。完成画像をreadbackし、entryには保持しない |
| readback staging／CPU出力 | finalは各4P、RGB readbackは各12P | MAP_READ/COPY_DSTのwgpu buffer＋CPU Vec。`finish_and_read`ごとに確保、StageCache外。stagingはTracked計量にも含まれない |
| hybrid Host | sampled/lin RGB32f、log scalar等 | CPU、描画中のみ。CPU sample、defringe/spot/local tone等のlin_cpu、CPU mask fallbackで発生。uploadしたGPU側と同時存在し得る |
| free pool／retired | raw buffer実capacity | GPU基盤。Buf解放後もpool／未submit退役listへ移る。StageCacheから消えても直ちにdriverのメモリが減るとは限らない |

`GpuStages`はsideごとに最大2 entry。CPU `StageCache`も別に最大2 entryであり、fallback後はCPU/GPU混在保持が可能。After/Beforeは2 slotなので「全体で2 entry」ではなく、GPUだけでも最大4 entry。entryはsrc Arcをpinする。source level／denoise sourceが変わるとArcが変わり、同photoでも旧entryと新entryがcapacity evictionまで共存し得る。

`GpuStages::get`はentryをcloneして参照を保持し、`put`で同key置換・古いentryの先頭evictionを行う。新buffer確保前に旧entryが解放される保証はない。小sourceは先に古いsource参照を外すが、alias／entry参照／retired／poolに実allocationが残る可能性がある。大shared sourceのコードも新旧の一時共存を明記する。

### 容量計量の限界

**事実（コード）：** `GpuStages::bytes()`は同一Arc<Buf>をside内で重複除外して`Buf.len×4`を合計する。`Gpu::buffer`は要求容量以上・最大25%余剰のpool bufferを再利用できるが、Buf.lenは要求長のまま。この場合logical bytesは実`raw().size()`より小さく、post-trimも実capacity上限を保証しない。uploadはpool再利用せず`create_buffer_init`する。host_source_bytesもVecのlenを用い、capacityではない。StagePoolはside間／CPU-GPU間の同じhost Arcを重複計上する可能性がある。

`gpu::memory()`のallocatedはTracked raw buffer実サイズで、使用中＋retired＋pooledを含む。ただしreadback staging、dispatch params、dummy、driver heapや他device等まで全てを覆う値ではない。dedicated VRAM使用量や常駐量そのものでもない。

## 5. CPU P0との違い

**事実（既存実測資料／依頼）：** CPU／512 MiB／1024×770でON 12/12、約80.5 MiB保持、Draft Warm 40.61 ms／Full Warm 41.52 ms、Full ON/OFF 6/6一致。CPU P0は実source Vec capacity、実Plan、全sideのArc identity、sampled/lin hitを使い、旧entryを課金したまま追加量を予約する。source decodeを一度だけ行いrun/acceptへ渡す。

GPUではCPU sourceに加えてdevice sourceコピー、GPU planes、pool capacity、readback、hybrid CPU一時領域、sourceの96 MiB境界、device limit／OOMがある。CPUの80.5 MiBをGPU必要量へ流用できない。GPU pathはstage kernelを使いながら一部CPU処理も行うため、二者択一のbackend表示だけでも不十分。

**条件付き算術例（実測ではない）：** crop等でsource levelがFullへ昇格せず、source=2560×1925、P=1024×770、capacity=lenと仮定する。

- host source：59,136,000 bytes（56.3965 MiB）。device sourceも同じlogical量で96 MiB以下、各side保持になる。
- 1 entryの最大logical保持：sampled＋lin＋全plane＝56P＝44,154,880 bytes（42.1094 MiB）。未使用plane／aliasがあれば減る。
- 1 side／1 entryのhost＋device source＋全planeは約154.90 MiB。CPU 80.5 MiBとは異なる。
- 2 side×2 entry、host source一つ、device source各side一つならlogical保持は354,027,520 bytes（337.6270 MiB）。置換追加、25%余剰、mixed CPU entry、一時buffer、poolを含むピーク値ではない。

一方Full source=3990×3000ならhost/device各143,640,000 bytes（136.986 MiB）、deviceはglobal sharedへ移る（upload可能なdevice limitの場合）。この約137 MiBがstage gpuBytesに出ない点にも注意する。source levelは`source_edge_needed`、crop、decoder、denoise等で変わり、今回ログには実source寸法がない。2560×1925を確定値としてadmitしてはいけない。

## 6. 安全に削減できる見積り部分

**推論／設計案：** 現行式に不要な予約が含まれることは構造上確認できるが、対象実機の過大分を一つの確定値としては算定できない。

| 改善候補 | 安全に成立させる条件 |
|---|---|
| edge²→実Plan面積 | 実effective settings、source、Planを使う。内部拡張・orientation・warp・prefilterは別に算定 |
| originalPixels×36→実sourceと所有者別計量 | CPU Vec capacity、device raw size、shared sourceを別々に数える。実CPU/deviceコピーを同じものとして重複除外しない |
| 毎回2サイズ全plane予約→今回の追加量 | 現在の全entryを課金し、sampled/lin hitをnativeと同じkeyで判定。新entryがputされる前の旧entryも残す |
| host sourceの重複課金除去 | 同一Arc allocationのみ全side／CPU-GPU entryを通じて一度数える。cacheがpinするallocation全量は残す |
| plane alias／既存Bufの再利用 | 実allocation identityとcapacityで計量。radius/quality変更時の旧新共存分を予約 |

まず既存GpuStagesのcapacity計量とsnapshotを設け、保守的な「全plane最大32P＋sampled/lin miss」をGPUにも適用する案が最小。未使用planeをsettingsごとに細かく減らすのは後段とする。shared sourceはStageCache所有量と別のresourceとして明示し、allocation前の保護から除外しない。

## 7. 削減できない領域とメモリリスク

現在の`stage_cache_budget_bytes`はMCP StagePoolのCPU pin＋GPU extensionの保持をadmission／描画後trimで制限するための予算で、以下全てのhard capではない。

| 区分 | 現行budgetとの関係 |
|---|---|
| 1. StageCache CPU保持 | CPU retained＋GPU host sourceを計上。ただしpost計量len／重複課金の限界あり |
| 2. StageCache GPU保持 | extensionのlogical Buf bytes。capacity余剰は漏れ、global sharedは外 |
| 3. 描画一時allocation | 一般のfilter／decode／readback／PNG等はこの上限の対象外。旧係数にも実ピーク保証はない |
| 4. GPU基盤／driver | shared source、pool、retired、pipeline、driver heaps等は別管理。StageCache clearで一括解放されない |
| 5. RSS | CPU decode cache、allocator残留、Python／native別process等もあり、StageCache予算と一致しない |
| 6. OS dedicated/shared GPU memory | residency／driver／他process等に依存。単純な合算を安全予算としない |

CPU sourceとGPU sourceは、統合GPUであってもコード上の独立resourceとして数える。物理共有と決めつけない。P0の所有者別境界は維持しつつ、cache予算とは別にworking／device resourceの見通しを示す必要がある。

post-render trimは次回以降の保持量を減らす役割であり、allocation前のOOMを防ぐものではない。poolへ退役するだけのclearをVRAM即時解放と扱わない。必要ならadmission拒否前の安全なpool trim／idle releaseを検討するが、in-flightのqueue orderingと再利用を壊さず、cacheを許可するためだけに必要領域を計算から消さない。

**事実（コード）：** `try_render`はerror scopeでOOM／Validation／Internalを捕捉する。OOMでは失敗したGPU stagesをclearしfree poolをtrimしてCPU fallback、fatal／device lossでは以後GPU停止。storage buffer limitやblank結果もCPU fallbackする。readback poll/map timeoutとalpha未書込みを検出する。OOM時の`gpu.trim(0)`は`trim_pool(0)`と異なりshared sourceを明示解放しない。device loss callbackやpanic等の別経路もあるため、全失敗で全resourceが即時解放されるとは断言できない。

fallback先CPU entryと既存GPU保持が共存する予算も必要。CPU fallbackが成功すれば描画は継続するが、CPU allocationも失敗し得る。現行`reason`はbudget/noneだけなのでGPU障害の理由表示には使えない。

## 8. 実装候補と影響範囲

**推奨案（未実装）：** 段階的に次を行う。今回はいずれもコード変更しない。

1. GPU `Buf`のlogical lengthとraw capacityを区別し、StageCache保持のsnapshotをallocation identityで取得する。GPU host Vec capacity、CPU/GPU混在、side間共有も対象にする。既存wire metadataの意味を変える場合は互換性を確認する。
2. headlessでP0同様の一度だけのsource取得と実Planに基づく事前算定を導入。式は「既存live allocation＋未計上source＋次renderのcache関連追加容量＋置換共存」。pool再利用時の最大余剰も予約するか、実際に選ぶcapacityで予約する。unknown/overflow/非対応条件は保守式または拒否へ戻す。
3. shared sourceと一時allocationは所有者を別に保ちつつ、device側の追加確保見積り・limitと診断に含める。2 side×2 entryやCPU fallbackを含むピークが予算外なら拒否する。一般working memoryをStageCache予算へ新たに包含する場合は契約変更として明記する。
4. 現行2 entry／sideとBefore独立性、source/geometry/mode/budget/errorのclear、run/accept、CPU P0を保つ。render後trimはcapacityに基づく防御として残す。

主な範囲は管理patch内のGPU ctx/render/lib、pipeline計量、MCP headless/previewとnativeテスト。後日の実装時にはmanifest digest、build.py probe、実binary receipt／SHAも更新・検証が必要。pixel処理・永続形式変更は不要と考える。snapshot APIのためEngine戻り値の追随が必要になる可能性はある。

### E. 実行GPUの確認方法

| 既存情報 | 分かること／不足 |
|---|---|
| `preview.measured.configuredBackend` | child環境へdx12を指定したこと。今回のGPU実行成功ではない |
| MCP preview metadataのquality/frame/stageCache | 品質・寸法・cache保持。gpuBytes=0でもuncached GPU演算は可能 |
| MCP `command_run(app.gpu)` | enabled/available/adapter/reason/lastFallback。lastFallbackはprocessの直近値で残存・他render上書きがある。今回の成功証明にはならない |
| MCP `library.memory` | engine source／rendered、gpu allocated/pooled/retired、work、任意heap。resource変化の補助証拠でありOS VRAMやkernel完了証明ではない |
| RAW Developer Diagnostics（A4） | GPU指定をexecution=unconfirmedとする。前後statusとfallback有無は得るが、rssBytes/vramBytesはnull。これは現状の限界を正しく表している |
| Developer Diagnostics WebGPU/JPEG | ブラウザ側の別renderer。native DX12 RAWの実行証拠にできない |
| native `RenderResult.gpu_fallback` | 試行失敗理由はあるがNoneは成功／未試行の両方。headless metadataへ実行結果は出ない |

**最小診断追加案：** `try_render`の結果をrender単位のtyped outcome（gpu_success／cpu_not_tried／cpu_fallback）、実backend/adapter識別、安全な固定reason codeでMCPまで伝える。GPU successはreadback・error scope・未書込み検査を通過した場合のみ。hybridがあるため全stage GPU実行とは表現しない。必要ならCPU stage bitsetを付ける。

さらにdebugでadmission path／estimate／existing capacity／additional bytes／source実寸とcapacity／Plan寸法／pool/shared/retired snapshotを同じrender ID・generation・revisionへ対応付ける。差分だけで実行を推定しない。budget拒否は回復可能なwarn、詳細容量はdebug、required renderの最終失敗はerror。logging失敗は処理を変えず、raw body・settings本文・無制限理由文字列・path・credentialは収集しない。これは将来案であり、今回のAPI／Backend／Frontendは変更しない。

## 9. テスト計画

今回の自動テスト再実行・実機測定はなし。以下の「既存」はソース上のcoverageで、今回成功を再確認したという意味ではない。

| ケース | 既存coverage／実装時に追加する自動検証 | Windows DX12実機での受入 |
|---|---|---|
| 1024px／512 MiB | 現行式922.96 MiB拒否を固定。新式は実source/Plan/capacityから期待値を算出し、収まるfixtureだけadmit | 同RAW・同settingsでestimateとraw capacityを照合。適用可否を固定しない |
| 十分なbudget／tiny | MCP `genzoroom_stage_pool_reuses_separates_and_enforces_the_total_budget`、e2e `genzoroom_cache_budget_and_full_after_draft_match_uncached`を拡張 | on適用・tiny拒否・描画継続、総容量計測 |
| 境界／overflow | P0 `genzoroom_cpu_required_bytes_tiny_budget_unknown_and_overflow_fail_closed`。GPUの必要量−1／等値／＋1、source/pixel/capacity加算乗算overflowを純算術fixtureで追加 | 異常巨大allocationを実機で無理に作らない |
| capacity／alias | GPU poolを最大25%余剰でseedしraw size課金を確認。sampled/source alias、base/log alias、host Arc共有を追加 | capacityとpool増減を確認 |
| GPU確保失敗 | 既存`gpu/tests/fallback.rs`はLimit/Validation/DropWork。OOM専用faultはないためallocation failure注入とCPU fallback、cache汚染防止を追加 | driver由来OOMは隔離processで制御可能な範囲だけ実施 |
| device loss | injected fatalは実device lossの代替ではない。callback/fatal経路のmock、以後GPU停止・CPU収束を追加 | 実driver resetはユーザー主導の隔離試験。成功画像／再起動回復を確認 |
| source切替／同source | P0 lifecycleとGPU shared-sourceテストがある。実Arc同一hit、変更miss、96 MiB両側、Full/Preview/denoise source切替を追加 | upload回数・旧source残留・長時間保持を確認 |
| 2 entry／Before/After | P0 `genzoroom_cpu_two_entries_both_sides_and_lifecycle_are_bounded`、GPU `windows_of_a_big_photo_share_one_uploaded_source`。GPU2サイズ×2side＋3番目追加・置換ピークを追加 | 小source二重upload／大source共有とraw allocationを照合 |
| mode／budget | 既存StagePool configure/finish。GPUからoff／budget増減、geometry変更、失敗後clearを追加 | logical解放とpool/OS常駐の違いを確認 |
| Full ON/OFF画像 | GPU `cached_renders_match_uncached`、CPU P0 exact一致を再利用。DX12同一backendでPNGではなくdecode画素の完全一致も検査、Draft→Full・WB/NR/効果/maskを追加 | 同設定・同source・同backendのFull一致。CPU対GPU近似一致と混同しない |
| CPU P0非退行 | CPU1024/512、capacity共有／置換、cold loaded→accept、Before、settings不変の既存回帰を実行 | CPU P0条件の再測定。DX12連続操作との時間優劣判定はしない |

mock／純計算はGPU不要で必ず実行し、GPU統合テストはadapterなしを明示skipする。実行GPUが未確認の試験をDX12成功として集計しない。パッチ実装時は関連MCP/pipeline/GPUテスト、管理patch検証、release buildと実binary probe／receiptを行う。診断契約を変更した場合だけ対応Backend／Frontend validator・診断テストへ範囲を広げる。現段階では全Frontend/Backend suiteやDocker Smoke Testは不要。

実機のみで確定するものは、当該adapter／driverでのGPU success、dedicated/shared memoryとRSSのpeak、device loss／driver OOM、実RAWの画質・性能・操作感。固定settingsのcold/warmと連続操作を別試験とし、OFF/ON、source切替、Before/Afterを同条件で比較する。

## 10. 未確認事項

- 添付ログの実行binary SHA、adapter／driver／device limit、renderごとの実GPU success。設定dx12と速度だけでは確定しない。
- 対象RAWの実decoded source・Vec capacity、effective settings、crop／denoise／hybrid stage、Plan内部寸法。約154.90 MiB等の例は実保持の報告ではない。
- raw buffer capacity別の保持・pool・retired・shared source、upload／readback・driverのpeak。post値だけでは途中peakは分からない。
- GPU失敗の全分岐でのcache／shared source解放時期、CPU fallback後の混在peakと回復性。特にOOMのpool trimとshared source保持は分けて実測する。
- 512 MiBでの全操作・全RAWへの適用可能性。大source、内部拡張、mixed、2 side×2 entryでは正しい拒否があり得る。

## 11. P2実装可否の判断

**条件付き可。** source／出力の一律上界と毎回の過剰予約には改善余地がある。一方、現行計量のcapacity漏れ・shared sourceの境界・置換peakを解決せず係数を下げる実装は不可。まずcapacity計量とrender結果診断、次に実Plan＋追加確保のadmissionを最小変更で行うことを推奨する。実際に必要量が512 MiBを超える場合は拒否を維持する。

本調査で行った検証は、ローカルHEAD/status・管理patch全diff/digest照合、提供JSON集計、関連ソース／テストの静的追跡、算術確認、文書diff確認と`git diff --check`。コード変更、build、binary起動、自動テスト再実行、ブラウザ操作、NAS検証は行っていない。README／CHANGELOG更新は不要。調査文書のCommit／Pushで終了し、P2実装には進まない。
