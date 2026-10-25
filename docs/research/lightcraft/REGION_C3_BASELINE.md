# C3-A Region baseline — 2026-10-25

C3-Aの計測結果。**製品値の確定や調整は行っていない。C3-Bへの進行にはユーザーレビューが必要。**
数値・view trace・各requestの結果は [REGION_C3_BASELINE.json](REGION_C3_BASELINE.json) に収録する。

## 条件と変更範囲

- 基準HEAD: `73ec7203b38aa470ab4c64c1f2d2bb116a9e3e97`、`feature/lightcraft-integration`。
- Windows開発版を現在のソースから `cargo build --locked` して起動。インストール版は計測に使用していない。
- Native: C2受入済みEXEを環境変数で明示指定。SHA-256:
  `7f4f76fd5c8989bf8439206c3bba778a753cf5e5b56359fb495cc14c4e914111`。
  実Viewerの `process.artifact` でも同じSHAを確認した。新Native binaryの作成・上書きなし。
- upstream: `a2a41383c4fd62fa85a46ccd00998639221f2d3c`、patch digest:
  `6d2e4113001aa8d9661ac706857191b2286ca420e4987be987bf55b6462609dc`。
- geometry descriptor contract 2、公開Before / Preview / Region各1を維持。
- Ryzen 7 3700X（8 cores / 16 threads）、Radeon RX 580、Windows、Python 3.14.5、Node 24.19.0。
- 標準RAW: 原版4080×3072、canonical Native 4064×3056。C2標準写真との一致を確認。
  保存Recipeは既にrevision 163へ進んでおり、C2調査時のrevision 120とは異なる。
  Recipe本文、写真識別子、私有path、画像、スクリーンショットは収録しない。

開始rho < 0.85、解除rho ≥ 0.95、aggregation / Zoom quiet各180ms、context 16、prefetch 64、F刻み256pxを維持。
C1 budgetも各軸2048、2,097,152 pixels、PNG 9 MiB、MCP line 13 MiBのまま。
Whole base / fallback、Native preflight、fail-closed、running 1 + latest pending 1、stale rejection、Draft / Full、pair、URL所有、JPEG、Recipe / History / saveを変更していない。

追加は既存debug診断の不足分だけである。

- `region.view`: viewport、DPR、scale、表示Zoom、Pan、Native寸法、interaction、view generation。
- `region.policy`: deduplicateされる既存reportと別に、実際の評価回数と最新viewからの経過時間。
- `region.planning`: requested / quantized F、actual F、requested / actual window、validRegion、limited、context / prefetch。
- `region.delivery`: queued / pending_replaced。既存started / accepted / stale / failed等と組み合わせる。
- `region.aggregation`: 既存の非延長timerの実待ち時間。timerを追加・延長していない。
- `region.received`: PNG payload bytesを既存の応答・body read・検証計測へ追加。

既存Backend `region.completed` のNative処理、transport/readback、validation、source level、StageCacheと、既存Frontend decode / pair待ち / adoptionを再利用した。
計測は既存loggerに従いopt-in。診断失敗は描画へ伝播せず、telemetryも追加しない。

## 測定の区別

1. **Controlled Native MCP**: 標準RAW、CPU / DX12 × StageCache OFF / ONの4 fresh processes。
   各processで28 view条件、うち25条件でRegion plan/render。全240 rows、216 Region calls。
   Fit / 50 / 75 / 100 / 125 / 150 / 200%のCSS scaleを、1952×1096のDPR 1 / 1.25 / 2と2560×1440のDPR 2で評価。
   Wholeを2048に固定した比較であり、Viewer schedulerやadaptive Whole全体を再現するものではない。
   cache ONは既存probeと同じ512 MiBの**test-only budget**、media budgetは1024 MiB。製品設定を変更していない。
2. **Windows Viewer**: 標準DNG、DPR 1、主なviewportは672×577。Fitで1952×1096も観測した。
   初回100%、小刻みPan、大きな移動、戻り、pair、Zoom、Zoom out → 再Zoom、document closeを実行。
   ユーザーの連続Panは8秒弱。自動dragの短いストロークと区別した。
3. **Synthetic production-owner tests**: 実際のAuto / Delivery / Overlayをmock transportで駆動。
   通常の100回Pan bounded testを維持し、即時応答のPan traceは実ユーザーtraceと別に集計。
4. **Offline pressure simulation**: 実ユーザーのview時刻を使用。geometry reuse / Whole gating / preflight / decodeを省くモデルであり、製品schedulerの代替実装ではない。

ViewerのZoomボタンは1.25倍刻み。100 → 125 → 156.25 → 195.3125%、100 → 80 → 64 → 51.2%を採取した。
正確な50 / 75 / 150 / 200%は通常のボタン操作で選べないためNative側の制御入力で比較する。
表示Zoomは `scale × DPR × 100`。Native matrixのラベルはCSS scaleなので、DPR 2のscale 100%はViewer表示200%に相当する。

## ログ欠落と再採取

最初の長いsessionはFrontend上限1000件を超え、367件、その後のsnapshotでは累計615件の古いログが失われた。
**最初の100%切替と初期の自動Panを完全なFrontend traceとして扱わない。**
JSONの `frontendStartRetained: false` が該当する。Backendの残存ログだけでFrontend成功を補完したことにはしない。

一方、ユーザーPanはsuffixの開始より後に全体が入り、292個のview generationが連続している。
新規documentでcold Regionと自動Pan / pairを短い区間として再採取し、開始から採用まで保持されていることを別途確認した。
累積drop counterは隠さず保存した。後続測定も短いsessionごとにexportし、FIFO suffixの開始・export時刻と対象区間を照合する。

## Cold / warmとlatency

Native cache OFFの単発値。時間はms、CPU / DX12は別process。

| 項目 | CPU | DX12 |
|---|---:|---:|
| cold Whole 1024 MCP round trip | 847.5 | 861.6 |
| 初回Full-source Region plan（decodeを含む） | 719.6 | 711.6 |
| warm 1:1 Region Native work | 109.8 | 78.4 |
| 同 MCP round trip | 189.8 | 165.2 |
| 同 Backend validator単体 | 57.9 | 57.4 |
| 同一window再render MCP round trip | 201.0 | 163.9 |

初回Full decodeはPanの通常性能へ混ぜない。cache ONの実測もJSONに別収録。
ONが常に速いとはいえず、DX12のrepeatは239.9msだった。各条件1 fresh processの測定であり、統計的な優劣は決定しない。

実Viewer（DX12、StageCache OFF）:

- 新規documentの100% view event → Full Region採用: **1732ms**。Native plan 754.3ms、render work 105.9ms。
- Warm Zoom out → 100%: **409ms**。初回decodeを含む経路と分離。
- 自動の短いPan: 最終view → Full採用 **486〜512ms**。
- Zoom quiet後のFull: 125 / 156 / 195%で **823 / 810 / 780ms**。
- 実ユーザーPan: 最初のview → 最初のDraft **727ms**、停止時view → 最終Full **851ms**。

実ユーザーPan区間のNative work中央値72.1ms、Native transport + readback中央値132.5ms、Backend validation中央値35.0ms。
decodeの観測中央値17.2ms。各requestのqueue wait、response wait、body read、decode、adopt waitはJSONに残した。
これらは重なり得る別の計測境界なので、中央値を足してend-to-end値にしない。

受入済みbinaryの `nativeMs` はPNG書き出しより前で止まるが、GPU readbackを含み得る。
MCP / Backend native時間との差分はPNG encode、file I/O、Base64、transport、settings readback等を含む**残差**であり、encode単体の実測ではない。
HTTP client start → admission、encode単体、GPU readback単体、HTTP body送信単体は取得不能として明示した。計測のための新Native patchは追加していない。

## Pan・context / prefetch

実ユーザーの1 gesture、**7984ms**（指定の1〜2秒より長い。2秒の値へ換算しない）。

| 項目 | 件数 |
|---|---:|
| view updates | 292 |
| policy evaluations | 108 |
| queued plan / render | 2 / 30 |
| completed Native plan / render | 2 / 20 |
| reuse / rebind | 13 / 13 |
| pending置換（item単位） | 10 |
| stale delivery discard | 14 |

Native render / view updateは**6.85%**。queued、実送信、完了、bitmap採用、identity rebindを同じ件数として数えない。
この区間でcancelled waiter / HTTP superseded / Region failure / explicit fallbackは観測されなかった。
normal Whole-only表示を「failure fallback」と数えてはいない。

prior adoption以降の291 viewのうち150（**51.5%**）は、直前に採用したvalid rectが幾何的にvisible rectを覆える条件だった。
これはquality / F / ownerも含めた**実際の表示保持率ではない**。Native render完了時に最新visibleがvalid域外となったcaseは0/20。
同qualityのNative render要求間のNative移動距離分布もJSONへ収録する。
contextの画質上の十分性はこの数字だけでは決められず、prefetchの増減も実施しない。

即時応答synthetic Panは別の結果になる。1000×750では100更新のうちreuse 97、追加render 2。
1952×1096ではlimitedなvalid域がvisible全体を覆えず、100更新でrender 100、reuse 0。
後者にaggregationや実latencyは入っていないため、実機で100要求が連続したという意味ではない。
C2でこのpartial overlayのPanが実用上問題なかった受入事実は維持し、request圧力とは分けて扱う。

## Aggregationのoffline比較

上記292 viewの実時刻を使用。service time仮定はNative transport/readback + validationの中央値167.5ms。
全sampleが仕事を必要とするpressure modelで、reuse・quality・Whole・decodeは入らない。

| aggregation | modeled requests | pending superseded | stale completions | final latency |
|---:|---:|---:|---:|---:|
| 50ms | 39 | 46 | 35 | 217.5ms |
| 100ms | 38 | 10 | 34 | 267.5ms |
| 180ms | 31 | 0 | 27 | 347.5ms |
| 250ms | 24 | 0 | 20 | 417.5ms |

stale completionsはモデル上の不要処理の指標で、実Nativeのcache価値まで判定していない。
実機の180msでは20 rendersだった。モデルの31を実測件数やViewer final latencyとして扱わない。180msを維持する。

## Rho / F / DPR

同一documentのZoom〜人手Panのdensity sequenceでは、現行0.85 / 0.95、hysteresisなし0.85、観測値から作った候補0.88581がいずれも3 transitions。
閾値直近の十分な実traceがなく、振動抑制の優劣は実測から決められない。
合成wobble `[.86, .84, .86, .84, .96]` では現行2 transitions、hysteresisなし4 transitions。
この合成結果を実機の画質評価と混同しない。

Native capを先に適用したrequested Fと256px quantized Fの変更回数は**7 / 7**。
この粗いZoom traceではreplan削減の証拠にならない。actual Fとsource levelはNative plan結果をJSONに保持し、反実仮想のsource level切替は未測定としてnull。
候補値は製品コードへ追加していない。

production Auto ownerを使うpure replayでもDPR 1 / 1.25 / 2を検査した。
1952×1096のFitではDPR 1 / 1.25はadaptive Wholeのみ、DPR 2ではRegion ON、desired F 3072。
高DPRのFitでRegionが必要になる設計を確認した。WindowsのDPI設定は変更していない。
粗さが目立つ境界・density gainが乏しい境界の視覚判断は後続Windows受入へ残す。

## Budgetとpartial coverage

各Native backend/cacheのactive 25条件のうち18条件（72%）でlimited。
**これは選んだstress matrixの割合で、ユーザー操作での発生頻度ではない。**

- 1952×1096、DPR 1、scale 1: F 4064×3056、bitmap **1280×1536**、1,966,080 pixels、limited=true。
  valid域によるvisible被覆率 **63.93%**、PNG約3.47MB。C2の既知caseを再現。
- 1952×1096、DPR 2、Fit: window 1024×2048、被覆率 **28.41%**、PNG約3.48MB。
- 2560×1440、DPR 2、Fit: window 1024×2048、被覆率 **18.03%**、PNG約3.74MB。
- matrix全体の最小被覆率 **17.09%**。actual window、validRegion、workWindow、source level、PNG bytesは各rowに収録。

Wholeがbaseに残るため、被覆率は「未描画の割合」ではなく「Regionのvalid品質で覆う割合」。tileは実装していない。
大きなviewportでの新たな人手Pan受入は未実施。C2受入と今回のNative / synthetic結果から、tile要否を先取りして決定しない。

## Before / After

実Viewerの同一位置100%では、pair ONでNative 1 plan + 2 renders、PNG合計3,272,364 bytes。
warm After単独の1,834,390 bytesに対して約1.78倍。pair切替のaction開始 → 採用1055ms、Afterへ戻す操作は341ms。
pair decodeは2回、中央値17.15ms、After decode後のpair採用待ち315.1ms。
action開始にはUI入力注入の時間も含む。Native / Frontend時間と別の指標である。
片側だけのRegion採用やpair契約の変更は行っていない。

制御Nativeの1952×1096 1:1でもAfter約3.47MB、Before約2.72MBを取得。
cache OFFではAfter / Before MCPはCPU 193.2 / 142.9ms、DX12 163.6 / 171.1ms。
Before用WholeやBrowser decodeを含まないNative単体の追加費用として区別する。

## メモリ

Windows PSAPI `WorkingSetSize`（resident working set）と `PrivateUsage`（private commit）を分離。
private commitをRSSやVRAMへ読み替えない。単位は以下MiB、Native cache OFF。

| Native段階 | CPU working set | DX12 working set |
|---|---:|---:|
| baseline | 8.6 | 160.1 |
| Whole 2048後 | 78.5 | 345.8 |
| 初回Region plan後 | 223.0 | 493.1 |
| 1:1 render中の20ms sample peak | 302.5 | 809.7 |
| 1:1 render返却後 | 228.1 | 783.2 |
| Region後にWhole 1472を再描画 | 227.8 | 656.6 |

最後の行はNative harnessのWhole要求であり、BrowserのZoom out / overlay解除とは呼ばない。
Native `lifetimePeakWorkingSetBytes` はprocess生存期間のOS peakで、個別renderのpeakではない。
20ms / 100ms pollingのpeakは瞬間最大を取り逃す下限観測である。

実Viewerの100ms採取ではNative working setの最大 **796.0MiB**、private commit最大 **1595.8MiB**。
100%切替action後約639.0MiB、pair切替action後約782.1MiB、51%のWhole復帰後約529.0MiB。
これらはaction開始1.5〜2.5秒後のsampleであり、pixel採用イベントへ厳密に同期したallocation計測ではない。
document closeで元Native processは終了。旧handleの最終sampleは約36KiB、新しいidle Nativeは約8.2MiB。
終了したprocessのRSSと新規processのRSSを同一processの縮小として描かない。

Backend本体、Python launcher、desktop hostは親子process関係で区別した。
観測working set peakはそれぞれ約141.7 / 5.1 / 106.6MiB。desktop hostはWebView rendererを含む合算値ではない。
Browser renderer使用量は未取得。deviceMemoryは機器容量のヒントであり、使用メモリとして採用しない。

Native diagnosticsの `sourceHostBytes` 150,405,120、`sourceCacheBytes` 214,491,296を、StageCacheと別に保持。
CPU cache ONのWhole 2048ではStageCache CPU / retained 231,339,264 bytes、GPU 0。
1:1 RegionはCPU / DX12とも512MiB admissionでbudget拒否、StageCache retained 0。cache OFFの0とも意味を区別する。
各rowのCPU / GPU / retained値を収録し、重なる所有量を足して総メモリとしない。

**GPU dedicated / shared memoryは取得不能。StageCache GPU bytesはVRAMそのものではない。**
PNG lengthとBase64 character countは論理サイズで、Browser Blob / decode allocationの実測ではない。

## 再実行と検証

- `native/lightcraft/region_c3_baseline.py`: 受入済みbinaryとprivate inputを明示し、CPU/DX12 × OFF/ONのNative結果を出力。
- `region_c3_trace.py`: 私有Frontendログからallowlistでviews / counters / timingsを投影。scheduler、rho、F比較はofflineのみ。
- `region_c3_report.py`: 全ログexportと操作境界、任意のPSAPI sampleからsession単位のsafe結果を作る。
  request IDは結合にだけ使い、時刻は区間内relativeへ変換し、PID・本文・識別子を出力しない。
- synthetic集計: Frontendの `rawRegionAuto.test.ts` を `--disableConsoleIntercept` で実行し、`C3_SYNTHETIC` 行を採取。

実行した検証:

- Frontend core対象10 files: 350 PASS。最終AutoはDPRを含む16 PASS。
- RAW/JPEG統合・Recipe/History/save等の追加対象: 191 PASS、既存失敗1件。
- Backend Region / MCP / Raw対象: 153 PASS。最終offline tool testsは8 PASS。
- 既存実RAW canonical probe: CPU / DX12 PASS。geometry contract 2、Preview→Full、cache source切替・settings不変を確認。
  Before/Afterは今回のNative harness、実Viewer、Frontend pair回帰で確認した。
- TypeScript + production build PASS。既存chunk-size warningあり。開発版desktop build PASS。
- `git diff --check` を実施。全Frontend/Backend suiteやDocker Smokeは変更範囲上不要なので実行していない。NASへdeployしていない。

既存失敗は `AnshitsuPersistence.test.tsx` の `switches after a successful PUT for a numeric adjustment edit`。
期待slider値0.5に対し1。単独実行でも再現し、**未変更の基準HEADを別の一時checkoutへ展開しても同じ失敗**。
今回の計測変更へ帰属させず、修正範囲を広げていない。全テスト成功とは報告しない。

監査では、診断OFF/DEBUGで同じNative要求数、timer非延長、所有とfail-closed不変、Native worker外のmemory sampling、artifact allowlist、drop counter・完全区間判定を確認。
Before fingerprint除外、未sample peakのnull化、DPR表示、generation更新時の採用時刻、cold / warm / 人手区間の分離、F cap順序を修正済み。
変更内のHigh / Medium残件なし。上記の測定限界・既存テスト失敗は残す。
実時計測におけるdebugログ自身のobserver costは較正していない。OFF/DEBUG同件数の確認は決定的mock workloadであり、実時間の完全な無干渉性を証明するものではない。

## C3-B以降へ渡す判断材料

閾値直近の細かなZoom traceと画質受入、aggregationの応答性、partial時のreuse条件とrequest圧力、prefetchの移動距離分布、256px刻みの細かいZoom比較が必要。
メモリの反復stress / capacityはC3-C、large viewportのpartial受入とtile要否は必要ならC3-Dへ渡す。
Dehaze最大3 LSB差の既存Native regressionは保持。Dehaze UI受入、NR / sharpening追加は今回の対象にしていない。
