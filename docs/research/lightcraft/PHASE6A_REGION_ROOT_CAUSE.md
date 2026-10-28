# Phase 6A-R: Whole/Region画質不一致の原因と最小修正設計

調査日: 2026-10-28。GenzoRoom `feature/lightcraft-integration`、対象HEAD `c4bdb90f24608720f595b3a8fe08006159dee327`。製品Frontend/Backend、管理Native patch/manifest、本番context/scheduler/DBは変更していない。既存Phase 6A記録も上書きしていない。

## 1. 結論

**airlight差、context不足、guidedのwindow依存格子はいずれも寄与が確認できた。** ただし非線形処理と量子化を含むため「最大64 LSBの何%ずつ」という加算分解はしない。残る最大1 LSB程度の全成分を格子だけへ帰属させることもできない。

* airlightを変えるだけのB実験で、十分なcontextのdehaze残差は大きく減る。例: CPU/1024/NR OFF/+100/context256はA **10 / 0.131468** → B **1 / 0.000003** LSB（max / mean）。2048では **11 / 0.164822** → **1 / 0.000009**。NR ONでもAの最大14/22がBで1へ減る。
* Bでもcontext16の最大62/54が残る。2048ではB/context64でも最大6、context128で最大1となる。**airlightだけ直しても足りない。**
* 同じROIでwindow originを1px変える、または幅を1px増やすとguidedの差が増える。subsampleを外す診断対照でこの増分がほぼ消える。**支持幅不足だけでは説明できない格子成分がある。**
* C（共通proxy）はRegion整合性を改善するが、既存Wholeそのものを最大10〜24 LSB変える。既存Whole画質維持を優先し、**Bを採用する方針**とする。

推奨する最小の修正範囲は、**Nativeで①Wholeと同じairlightの共有、②依存filterに応じた内部work window拡大、③Regionのguided係数をWholeのglobal gridへ揃えること**。Wholeの現像式を変更せず、GenzoRoomの本番context16・scheduler・設定/DB/APIを変更しない。3つは別の原因なので、context256一律化やB単独を完成案にはしない。本書は設計までであり、これらの製品修正は未実施。

## 2. 隔離・再現性・測定条件

| 項目 | 確認内容 |
|---|---|
| LightCraft | v0.14.0 / upstream `03c88c166c054c009db2a47187d59991f6232b85` |
| 正規EXE SHA-256 | `b872315ccd11c5c2e945f473d8ca48022127a4cc196b95d16ff3d8fb75004251`。manifest/隣接receipt検証成功 |
| 管理patch | `0002-v0.14-native-contracts.patch`、SHA-256 `9308d0663de3e4d1f6fd65e564fb04cc7ac1c993b5c1a2aae29ef1f72b521063` |
| 隔離source / target | `.tmp/lightcraft-phase6ar` / `.tmp/phase6ar-target`。ローカルcloneに管理patchを検査・適用後、診断だけを追加。ネットワークfetchなし |
| 診断EXE SHA-256 | `97f2c2f77f63b1e4c3fb55b199bffff4417962baf567d553846a7c6221a40868`。正規artifactとしてのreceiptは発行しない。コピーされた旧receiptも削除 |
| build | `cargo build --offline --locked --release --no-default-features -p lightcraft-cli --target-dir <isolated-target>`。rustc 1.99.1 / cargo 1.99.1。既存build出力を**コピー**して依存buildを再利用し、正規targetは変更しない |
| 正規版との対照 | dehaze+100/1024/Full/NR OFFのWholeとcontext16中央Regionを正規版・診断Aで比較。CPU/DX12とも**画像差0**。Phase 6Aの中央max62/mean0.413740も再現 |

`LC:`は隔離cloneまたは同一管理基準のNative相対パス、`GR:`はGenzoRoom相対パス。出所・診断moduleの正規化SHA-256・generator SHA・compiler版は[測定JSON](PHASE6A_REGION_ROOT_CAUSE.json)の`diagnosticBuild`にも記録した。

隔離buildは成功。`craft-fonts`未配置の警告があったが、GUI textではなくheadless画素出力を比較しており、上記の正規版parityは差0だった。

### 診断変更は次の4点だけ

再現用`native/lightcraft/region_root_cause_native.py`が差込み箇所の一意性を確認して適用する。

1. 隔離`pipeline/src/region_cause.rs`を追加。専用control fileから任意の有限な正airlight値とguided対照modeを読む。
2. CPU `pipeline/src/lib.rs::render_impl`、DX12 `gpu/src/render.rs::render`の`plan.fixed_air`適用境界で、`plane`（window自身の推定）、`proxy`、`current`（通常選択値）、`used`（実際にFinishへ渡す値）を取得。専用CSVへf32 bits・寸法・backendだけを書く。
3. B/Cではこの最終scalarだけを差し替える。settings、window、filter、encodingは同じ。`FinishParams::new`の`air_pre`に入り、post-exposureの`air=air_pre*gain`へ接続する。今回露光0なのでgain=1。
4. `local::guided_fast_step`を診断mode時だけ1にする。CPU/GPUが共通helperを参照するので両経路に作用。これは**原因切り分けの対照であり製品修正候補ではない**。

通常のstdlib/browser出力を自動収集したものではなく、明示した専用数値診断。写真pixel bufferやsettings本文をログへ書いていない。製品settings schema、JSONコマンド、Recipe/Historyには診断項目を追加していない。

### 素材・matrix

`effects_probe.py::procedural_scene`をそのまま再利用。1024×768の階調・周期texture・矩形境界を2048×1536へbicubic拡大してimportした**合成RGB PNG**。検索できた既存RAW拡張子ファイルは最大15bytesのfixtureで、代表実RAWは利用できなかった。カメラRAWのsource decodeや性能として扱わない。

* 主実験: CPU/DX12、1024/2048 grid、dehaze+40/+100、NR OFF/ON（輝度100・カラー100、NR detail/smoothnessはNative既定値）、Full。+100は同gridのDraftも追補。その他はBASEと同じ（texture/clarity/sharpen=0、RAW専用値等を勝手に追加しない）。
* 中央、Pan（中央から13px/7pxずらす）、左画像端、四隅。Fullはcontext16/64/128/256、Draftは中央/Pan/edgeとcontext16/256。
* A/B/Cと補助filter実験の合計**1680比較**、24個のWhole/proxy airlight条件群。加えてguided対照48条件、CPU/DX12直接画像比較24条件。主画質実験はstage cache OFF。
* ROI384×288を固定し、同settings・virtual full grid・quality・backendのWhole crop/Regionを比較。context拡大で画像端に接した場合はNativeのvalidRegionを広げる契約を守り、比較ROI自体は動かさない。元のROIと48px内側のmax/mean/p50/p95/p99、3/8 LSB超channel割合を記録。分母は画素数でなくRGB channel数。
* Regionはこの合成bitmapの`SourceLevel=Preview`であり、RAW Full sourceへの切替実験ではない。素材と元bitmapは同じ。実応答のexecutionでCPU=`cpu_not_tried`、DX12=`gpu_success`を検証。silently CPUへfallbackした結果は採用しない。

## 3. airlightの実測とA/B/C

### 3.1 描画で実際に使われた値

以下はFullの実測f32を丸めて表示。+40/+100で同じ値（dehaze量は推定入力に入らない）。Regionのproxy値は中央・Pan・画像端・四隅・各contextでbit単位で同じことをassertした。Draftの実値もJSONに保存している。

| grid | NR | Whole CPU air_pre | Whole DX12 air_pre | Region proxy（両backend） |
|---|---|---:|---:|---:|
| 1024 | OFF | 0.4697038829 | 0.4697038531 | 0.4692708254 |
| 1024 | ON | 0.4700806737 | 0.4700806141 | 0.4692708254 |
| 2048 | OFF | 0.4697999954 | 0.4697998166 | 0.4692708254 |
| 2048 | ON | 0.4702552259 | 0.4702547789 | 0.4692708254 |

原因経路は`LC:pipeline/src/lib.rs::plan`、`local.rs::frame_airlight/airlight/airlight_of`、CPU/GPUのprepare。

* Wholeは現像gridのscene-linear画像にWB・NR等を適用した後のdark Gaussianから、7画素ごとのsampleの99.5 percentile（下限.05）を取る。
* Regionの`frame_airlight`は長辺384px以下の全体proxyを作り、WBとdark Gaussianを実行する。**NR、local tone、defringe、spots等のlin処理をWholeと同じようには実行しない**。今回NR ONでもproxy値が変わらずWhole値が変わることを実測できた。
* さらにproxyの縮小grid・sigma・sample位置/数がWholeと異なる。単に「同じ全体画像を参照しているから同じ推定値」とはならない。

### 3.2 対照実験

| mode | Wholeのairlight | Regionのairlight | Whole互換性 |
|---|---|---|---|
| A | 現行Whole値 | 現行proxy値 | 変更なし |
| B | 現行Whole値 | **同じbackend/grid/quality/settingsの実測Whole値** | Wholeを一切変更しない |
| C | proxy値を強制 | 同じproxy値を強制 | Wholeの見え方が変わる |

以下はCPU、dehaze+100、中央、Full、NR OFF（max / mean LSB）。B/Cの強制値が実使用f32と一致したことを各描画で検証した。

| grid / mode | context16 | context64 | context128 | context256 |
|---|---|---|---|---|
| 1024 A | 62 / .413740 | 10 / .131459 | 10 / .131465 | 10 / .131468 |
| 1024 B | 62 / .292155 | 1 / .000015 | 1 / .000024 | 1 / .000003 |
| 1024 C | 62 / .292438 | 1 / .000024 | 1 / .000018 | 1 / .000021 |
| 2048 A | 54 / .369882 | 15 / .169054 | 11 / .164819 | 11 / .164822 |
| 2048 B | 54 / .260899 | 6 / .010745 | 1 / .000012 | 1 / .000009 |
| 2048 C | 54 / .260447 | 7 / .010923 | 1 / .000009 | 1 / .000018 |

context256での分布の例:

| grid / NR / mode | max / mean | p95 / p99 | 3 LSB超 | 8 LSB超 |
|---|---|---|---:|---:|
| 1024 OFF A | 10 / .131468 | 1 / 1 | .0187% | .0012% |
| 1024 OFF B | 1 / .000003 | 0 / 0 | 0% | 0% |
| 2048 OFF A | 11 / .164822 | 1 / 1 | .0226% | .0012% |
| 2048 OFF B | 1 / .000009 | 0 / 0 | 0% | 0% |
| 2048 ON A | 22 / .310384 | 1 / 1 | .1185% | .0109% |
| 2048 ON B | 1 / .000329 | 0 / 0 | 0% | 0% |

Bは主実験の全位置・+40/+100・NR OFF/ONで、context128/256なら最大1 LSB以内。CPUの最大meanはcontext128で.000561、256で.000533。DX12はそれぞれ.000109。context64では2048に最大6が残る。これらは**今回の素材/gridの測定値であり、128を任意RAWの本番contextとして推奨する証拠ではない**。

### 3.3 C案が既存Wholeを変える量

Whole全体のA→C差（中央ROIだけでなく全画像）。CPU値、括弧内はDX12のmax。+40では全条件max1 LSB、+100では以下。

| grid | NR | max LSB | mean LSB | 3 LSB超割合 |
|---|---|---:|---:|---:|
| 1024 | OFF | 10（10） | .072481 | .0112% |
| 1024 | ON | 16（16） | .137559 | .0631% |
| 2048 | OFF | 14（14） | .088017 | .0138% |
| 2048 | ON | 23（24） | .167144 | .1121% |

差は局所的だが既存Wholeの結果を変える。Bでも整合性が得られる以上、この変更を今回の修正に混ぜる必要はない。Bへのscalar強制はairlight取得コストを含む製品実装ではないため、実装性能を証明したものではない。

## 4. filter支持幅とcontext不足

[Rust計算記録](PHASE6A_FILTER_SUPPORT.json)は、再現用`filter_support_probe.rs`を隔離buildの実rlibへlinkして、`box_radii`、`plane_sigmas`、`guided_fast_step`、`nr_params`を**実行**した結果。別言語でsigma式を近似移植した数値ではない。

Gaussianは各軸3回のbox pass。各軸のinput支持半径は`r0+r1+r2`。guided係数はmean/correlationからa/bを作り、さらにblurするため**直列に2回分**を参照する。シャープはtextureとfine planeを共有し、amountが増えても別の半径を追加しない。

| ppl | texture 3半径 / 合計 | dark 3半径 / 合計 | clarity sigma / step | low Gaussian 3半径 / 合計 |
|---|---|---|---|---|
| 1024 | 1,1,2 / 4 | 20,20,20 / 60 | 12.288 / 4 | 2,3,3 / 8 |
| 2048 | 3,3,4 / 10 | 40,40,41 / 121 | 24.576 / 8 | 2,3,3 / 8 |
| 4096（画像未測定） | 7,7,7 / 21 | 81,81,82 / 244 | 49.152 / 16 | 2,3,3 / 8 |
| 6000（画像未測定） | 10,10,11 / 31 | 119,119,120 / 358 | 72 / 16 | 4,4,4 / 12 |

`ppl`は`Frame::px_per_long`によるoriented-image長辺単位の出力密度。cropでpplが出力長辺を超えることがある。単にUIの長辺値だけから余白を決めない。Nativeの`radii_for`には画像サイズに応じたsigma capもあるため、極端な小windowではそれも一致条件に含む。

### 直列の前段支持も必要

NRは`local::apply_nr`で輝度guided→カラーGaussianの順。輝度guidedはsubsampleしない。今回のNR量100・smoothness50で、source長辺2048に対し:

| 出力grid | NR scale | 輝度sigma / 1 Gaussian半径合計 | カラーsigma / 半径合計 | NRの直列支持見積り |
|---|---|---|---|---|
| 1024 | .5 | 1.75 / 4 | 5.625 / 15 | 2×4+15=23 |
| 2048 | 1 | 3.5 / 9 | 11.25 / 32 | 2×9+32=50 |

したがってdarkまでの局所支持は、同じsampling済みgrid上でNR OFFなら60/121、NR ONなら**83/171**まで延びる。smoothness100ならカラー半径合計21/43になり、NR支持は29/61へ増える。量だけでなくsmoothnessも見る必要がある。

clarityは低解像度で2×8の係数支持を持ち、これをglobal scaleで戻した64/128pxに、Box downsampleとBilinear upsampleのtap範囲・丸め余裕が加わる。さらに前段NR支持を加える。正確な必要領域は、`raster::resample::weights`の実tap indexから**各軸ごと**に逆算する設計とする。sigmaを1回足しただけのhaloではない。Lightのhighlights/shadows併用時はtone baseのguidedとV2 medianもclarityのmid weightへ入る。parallel branchはmax、直列処理は支持を合成する。

83/171等は**source上の支持範囲の算定**であり、未測定の83/171を本番contextへ設定する推奨ではない。今回context128でdehazeが1 LSB以内でも、外周の小さい重みが量子化で見えなかった可能性があり、任意の画像内容での保証にはならない。

### 実測で改善する成分・改善しない成分

* airlightを一致させたBでcontext16→128にすると、dark境界の大きい差が減る。1024の中央内側48pxはB/context16ですでにほぼ一致する一方、周辺には最大62が残る。支持幅不足の分布と整合する。
* Aではcontext256でも中央内側のmeanが1024で約.149、2048で約.155 LSB残る。Bではこの成分が消えるので、haloを増やしても消えないairlight差を分離できた。
* texture単独の全位置・両gridはcontext16でもmax1。これは今回のtexture支持4/10と整合するが、4096以上やNR前段込みの一般保証ではない。
* clarity単独はcontext16でmax6、64以上でmax1。ただしPan位置でmean約.014が256でも残る。下記の格子実験へ進む根拠となった。
* texture/clarity/dehaze各70＋NR100/100＋sharpen150のB補助実験はcontext16でmax10、64/128/256でmax1。meanはgrid/位置により格子残差を含む。全条件はJSONの`case=combinedNRSharpen`を参照。

## 5. guided格子の因果実験

対象: `LC:pipeline/src/local.rs::guided_fast/guided_coeffs/guided_apply`、`gpu/src/render.rs`の同名処理、`raster/src/resample.rs::weights`。

低解像度寸法は`L=ceil(N/s)`。実際のresize scaleは**N/L**でありsそのものとは限らない。global位置は`origin+(j+.5)*N/L`、再拡大側にもその対応が必要。現行はwindowごとにorigin=0のローカルplaneを作るので、window起点のずれとceilによるscale変化の両方が起きる。GPUもCPUが作るweight tableを用いる。

clarity+100のみ、Full、NR OFF、airlight非依存。比較ROIは固定、windowは640×544を基準とし、各辺に少なくとも約120pxの余白を確保。1024ではs=4、2048ではs=8。windowの起点を1、s-1、s px動かす実験と、幅だけを1、s px増やす実験を実施。context metadataは64で、比較ROIはそのvalidRegion内の同じ画素。したがってROIがwindow端へ寄ったことによる支持不足との混同を避けた。

CPU、Whole/Region mean LSB（maxはいずれも1以内）:

| grid / 診断mode | 整列640幅 | 起点+1px | 起点+s px | 幅+1px | 幅+s px |
|---|---:|---:|---:|---:|---:|
| 1024 / native subsample | .000012 | .015387 | .000015 | .051912 | .000012 |
| 1024 / step=1対照 | .000018 | .000021 | .000021 | .000018 | .000018 |
| 2048 / native subsample | .000030 | .001766 | .000033 | .023603 | .000030 |
| 2048 / step=1対照 | .000027 | .000024 | .000027 | .000027 | .000027 |

DX12でも1024の幅+1は.051927、step=1では.000006。2048は.023609→.000006。**s倍の位相/寸法で復帰する周期性と、subsample除去対照での消失から、window依存格子の寄与を確定する。** 微小なrunning sum・affine・量子化差は対照にも残るので、max1のすべてが格子起因とはしない。

global grid化は、Wholeの`full_w/full_h`から既存と同じ`Lw/Lh`を一度決め、そのglobal indexの必要区間だけをRegionで処理する。整数のs倍へwindowを丸めるだけでは、`full_w % s != 0`の画像やceil寸法変化に対応できない。global centerとweight tableの参照を保持し、係数Gaussianは真の画像端だけでclampする。CPUは`guided_apply`のglobal低解像度index、GPUはresize/係数bufferのorigin-aware tableを使う設計。Wholeの係数生成/表示は変更しない。

低解像度の必要tileとhaloだけを持つなら全Whole planeの保持は不要だが、**その実装の時間・メモリ・VRAM増分は未測定**。step=1対照は別アルゴリズムの費用であり、global grid化の性能値に流用しない。

## 6. CPU/DX12、性能、メモリ

### backend比較

直接CPU/DX12比較は、1024/2048、NR OFF/ON、dehaze+40/+100のWhole、中央context256 Region A/B（24条件）。**max1 LSB、最大mean .000300 LSB**。実airlightにはbackendごとのf32演算差があるが、両backendでAの残差→B/Cで改善という結論は同じ。GPU固有の描画失敗をCPU結果で隠していない。

### 要求面積と性能

独立processで性能のみ追補（JSON `performanceRecheck`）。virtual full1536×1152、ROI384×288、clarity70/dehaze100、輝度/カラーNR100、Full、A、cache budget512MiB。各cold/反復1sample。Stage coldはこのgeometryのstage entryがないという意味で、RAW decode/process coldではない。request時間は診断file IO・MCP・PNG decode込み。

| 要求 | 描画面積 | context16比 | PNG CPU bytes | CPU 初回 / 反復 ms | DX12 初回 / 反復 ms |
|---|---:|---:|---:|---:|---:|
| Whole1536 | 1,769,472 | — | 1,826,322 | 196.252 / 117.091 | 157.671 / 104.713 |
| Region c16（416×320） | 133,120 | 1 | 151,497 | 46.019 / 26.185 | 43.010 / 24.658 |
| Region c64（512×416） | 212,992 | 1.60 | 239,697 | 60.470 / 32.071 | 44.515 / 30.893 |
| Region c128（640×544） | 348,160 | 2.62 | 383,629 | 72.730 / 43.584 | 59.053 / 76.597 |
| Region c256（896×800） | 716,800 | 5.38 | 758,728 | 122.775 / 122.573 | 98.171 / 108.372 |

**cache ON要求とcache適用成功は区別する。** CPU c16/64/128は両回`applied=true`。DX12 c128は初回true、反復は`reason=budget/applied=false`。c256はCPU/DX12とも両回budget拒否。後者を「warm cacheでもこの速度」と呼ばない。`StagePool::prepare`はold/new overlapも計上するため、保持bytesが512MiB未満でも次のadmissionが通るとは限らない。今回それを最適化・上限緩和していない。

### メモリ

Windows `GetProcessMemoryInfo`でprocess working set / cumulative peak working set / private bytesを要求後に取得し、数値をJSONへ保存。上記独立性能processでのcumulative peakはCPU約164.7MiB、DX12約354.0MiB。Whole warm直後のworking setはCPU約114.3MiB、DX12約320.3MiB。これはallocator・driver・source・cache等を含み、各request中のpeakを時系列samplingした値ではない。context増加時のcache evictionにより、要求後working setが単調増加しないことにも注意する。

Nativeが報告したWhole warmの保持量はCPU側101,449,728bytes、DX12ではhost37,748,736＋device101,449,728bytes。device値は**アプリが保持するGPU buffer容量**でありresident VRAMの実測ではない。OS上のVRAM常駐量・transient peak、RAW decode時peak、最適化後B/global-gridの費用は未測定。

B実験はすでに測ったWhole scalarを注入するので、**必要なWhole gridのairlightを初めて取得する費用を含まない**。それを安いscalar共有だけの実装性能とは報告しない。初回は同じsample/WB/NR/dark処理が必要になり、既存Whole stageを使えなければ全gridのprepassが必要。Whole全部のfinish/PNGまで再描画する必要はないが、その最小prepassは今回製品実装・benchmarkしていない。

## 7. 修正案の比較

| 方式 | 改善範囲 / Whole画質 | 性能・メモリ・契約 | 判断 |
|---|---|---|---|
| Native airlight B | 十分な余白のdehaze残差を1 LSB以内へ。Whole維持 | 同grid/quality/backend/lin入力のscalar cacheが必要。初回exact取得の費用と一時bufferをadmissionへ追加。Region API/DB変更不要 | **採用**。単独ではc16の境界差を直せない |
| Native共通proxy C | B同様にairlight残差改善。既存Wholeが最大24変化 | 安価な共通proxyを使いやすいがNR等の意味が現行Wholeと異なる | 今回不採用 |
| Native内部work window拡大 | filter支持不足を改善、Whole維持 | `Plan.keep`で要求windowへcrop backすれば転送サイズ維持。work側の寸法/面積/CPU/GPU budgetは厳守 | **採用**。格子とairlightは別対応 |
| guided global grid | 起点・ceil寸法に起因するPan差を除去。Whole維持 | Region側のorigin-aware coefficients/tapsが必要。tile化なら全係数plane不要。実装後性能未測定 | **採用**。step=1への置換はしない |
| GenzoRoom context拡大 | 測定範囲で境界差改善、Aのairlight残差は残る | c256で面積5.38倍/PNG約5倍、StageCache budget拒否。SourceLevelやglobal格子は直らない | 本番設定変更は不採用 |
| Effects中Whole fallback | 同じWholeだけならsurface差を避けられる | `GR:rawWholePreview.ts`の上限2048。今回2048素材なら100%だが高画素RAWでは100%密度を満たさない。転送・finishが全体分、StageCacheも別geometry | 最終解決には不採用。必要なら制約付き暫定策として別判断 |

DB/Recipe互換層では画質差を解決できず、DB migrationは不要。

## 8. 推奨する最小修正の境界

1. **Whole基準airlightをNativeで共有する。** Wholeの既存値を読み出し、Regionでは同じWhole Planのlinear入力・dark sigmaに対応する値を使う。小さいWhole previewのscalarを高密度Regionへ流用しない。所有者は既存Native StageCache/StagePoolに近い有界cacheとし、キーはsource/content、Whole geometry/grid、Whole lin_key、dark radius、quality、backend等の実入力から構成する。dehaze量だけの変更やPanで不要な再計算を起こさない。Before/After、WB/NR/profile/geometry、source変更とevictionを検査する。Recipeにこの派生値を保存しない。
2. **必要windowはNativeで決め、現在のrequest/responseを維持する。** sampling→NR→dark/texture/clarity等の実tap依存を逆算し、spotsの既存work拡大とunionする。`Plan.keep`で要求windowへ戻す。CPU `cpu_admission_bytes`、GPU `stage_admission_bytes/StageCache::additional`は実work面積とairlight prepassを計上する。MCP `region.rs`のwork検査（各辺2048、2,097,152画素）とsource予約を緩和しない。収まらない場合は既存のfail-closed errorを返し、画質を落とした結果に同じラベルを付けない。
3. **Region guidedをglobal indexへ接続する。** Wholeから計算した低解像度N/ceil(N/s)を維持し、必要係数tileとhaloのglobal起点を与える。cacheのgeometry/plane keyにも位相・gridが異なる条件を含める。CPU/GPUの同じweight生成規則を使い、全frameの係数を常時保持する設計や無条件step=1は避ける。

これが、既存Wholeを変えずに今回確定した3要因を処理する最小の**責務範囲**。単なる変更行数最小の案ではない。Native内部だけで解決する方針を確定するが、Bの初回prepassとglobal-grid実装後の費用は受入で測定する必要がある。画質を変えるCや安全上限緩和へ自動的に切り替える方針は採らない。

実装順はB→work支持→global grid。各段階で同じROI対照を取り、Bだけ・余白だけで完了扱いにしない。

## 9. 実装時の受入条件と残存リスク

* 本調査のA出力をWhole referenceとして固定。修正後Wholeは変更なし（同じbackend/quality/cache条件で画素一致）。Cの画質変更を混ぜない。
* 本matrixで修正後Whole/Regionの**max≤1 LSB、mean≤.001 LSB、3/8 LSB超0**を目標にし、画像端/四隅/Panで確認する。格子実験の同一ROI・異windowでもmean≤.001を目標にする。これは今回の観測を基にした提案基準であり、すべてのRAWへ確認済みの契約ではない。
* 同じROIを連続Panで描き、global位相由来の周期差をなくす。full gridがsで割り切れない寸法、crop/flip/straighten、画像端、Light/NR/シャープ併用、Draft→Full・cache近似も追加する。今回の格子対照は1024/2048の割切れるWhole寸法で、**非整数global scaleでのglobal-grid修正は未実装・未検証**。
* Bのscalar取得に使ったsource/grid/quality/backendを識別できる診断を実装時だけ用意し、cache hit/失効/eviction、古い非同期結果、Before/Afterの混入、再生成を検査。Native設定/History/Recipeを変えない。
* 本番context16のまま内部work拡大した実応答の幅/高さ/window/quality/geometryIdとPNG上限を検証。budget不足・拡大後2048辺/面積超過時に失敗し、上限を緩めないこと。古いbufferと新bufferの共存、初回airlight prepassも予約する。
* 性能は同source/gridで実装前後のstage-cold/warm、実際のcache適用、process peak、GPU buffer/可能ならresident VRAMを測る。今回の強制scalar注入時間やstep=1対照時間を製品B/global-gridの費用として代用しない。
* 実RAWは未測定。4096/6000行は支持計算だけ。大きいRAWの100%、source level切替、camera profile/local tone、spot/warp、AI NR、HDR/露光非0、特殊WBの画質と性能は今回の結果から断定しない。
* 残る1 LSB以下の差の浮動小数点演算/quantization別の寄与率、global-grid実装の実メモリ増分、B初回exact prepassの最小費用は未確定。これらがあることと、airlight/context/格子の因果が確定したことは分ける。

## 10. 再現手順と後片付け

1. 正規checkout/manifest/receiptを確認し、ローカルcloneを`.tmp/lightcraft-phase6ar`へ作る。既存正規targetのコピーを`.tmp/phase6ar-target`へ置けば依存buildを再利用できる（共有hardlinkは使わない）。同じ診断を二重適用しないため、新しいcloneから開始する。
2. リポジトリPythonで `native/lightcraft/region_root_cause_native.py --source .tmp/lightcraft-phase6ar --target .tmp/phase6ar-target`。正規checkout以外への管理patch適用・一時診断差込み・offline buildを行う。
3. `native/lightcraft/region_root_cause_probe.py --binary .tmp/phase6ar-target/release/lightcraft-cli.exe --json-out <新しい結果JSON>`。A/B/C・guided・performance・正規版parityを記録。既存Phase 6A出力は渡さない。
4. 同じJSONに`--performance-only`を付けて実行すれば、独立processのcache適用/メモリを追補する。`--cross-only`は24件のCPU/DX12画像直接比較だけを追補。元の画像実験を繰り返さない。追補時は両EXEのSHAを照合する。
5. `filter_support_probe.rs`は`rustc --edition=2024 -L dependency=.tmp/phase6ar-target/release/deps`に、同depsの最新`liblightcraft_pipeline-*.rlib`、`liblightcraft_raster-*.rlib`、`liblightcraft_develop-*.rlib`、`libserde_json-*.rlib`をそれぞれ`--extern name=path`で指定して一時EXEへcompileし、stdoutのJSONを新規結果へ保存する。

全probeの子processは`client.close`→必要ならterminate→waitで終了させた。元のstashを保持。正規checkoutは`build.prepare(..., apply=False)`で管理patchとの差分が所定どおりであることを再検証し、正規EXE digest/receiptも照合した。診断clone/targetは再現用に`.tmp`へ残すが正規runtimeからは選択されない。診断版を配布・登録していない。

製品コード変更がないためFrontend/Backend全suite・production buildは再実行しない。隔離Native release build、実描画probe、実Rust支持計算、JSON/ROI/traceのassertと整合検査、`git diff --check`を実施する。NAS/Firefox/ブラウザ手動確認は行っていない。
