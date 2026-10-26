# C3-B: Region Plan cold latency（2026-10-26）

## 結論

Region Plan約650msの支配要因は、LightCraftの`job.source.load_source()`による初回Full source取得・生成である。同じRAW・geometryで再測定したNative中央値660.0944msのうち659.8211ms（約99.96%）を占めた。planner計算そのもの、GPU upload、StageCacheのmissではない。

同一documentの2回目PlanはNative中央値0.2539ms、Region Fullと1回のPanの後の再Planは0.2190ms。最初は`SourceRef::File`、以後は`SourceRef::Loaded`だった。Full decoded sourceは既存のMediaCacheで再利用されており、毎回650msかかる状態ではない。一方、新document／新processでは再発する。

## 条件と測定範囲

- LightCraft v0.14.0、固定upstream `03c88c166c054c009db2a47187d59991f6232b85`。
- DX12 / Radeon RX 580 Series、Native 3990×3000、Whole 1024×770、Region 768×576、StageCache OFF。
- ユーザー指定RAWで、提供されたDeveloper Diagnostics JSONのgeometry descriptor全体（geometryIdを含む）との一致を確認。
- 既存`RawPreviewSequence` / `sequence_plan(3)`のOpen、Whole Draft、Whole Full、mutation Draft、end Fullを経て`regionPlan`を測定。warm-up 1 + measured 3、各回で新process・新document。
- source再利用確認のため、各回の初回Plan直後（Region Full/Panより前）にPlanを1回追加。既存Region FullとPanを各1回行い、Pan後にもPlanを1回追加。
- Frontend/HTTPは実行せず、既存Viewer benchmarkのBackend sequenceを使用。今回の`backendOperationMs`にはget_settings、MCP往復、validation等が含まれ、Browser totalとの同一視はしない。
- 入力確認前の予備測定では別RAWを使ってしまった。その4 sequenceは本表・証跡JSONから除外。別の候補は寸法ガードで中止。その後、指定RAWだけで上記4 sequenceを取得した。
- OS filesystem cacheはflushしていない。「cold」はdocumentのdecoded Full source未保持を意味する。

## 主要内訳

測定3回の中央値。各項目の中央値を独立に求めているため、表の和は総時間と厳密には一致しない。各個別trialでは内訳合計と`nativeMs`の一致をvalidationする。

| 処理境界 | 初回Plan (ms) | 同一documentの2回目 (ms) |
|---|---:|---:|
| source preparation（request検証・render_job構築等） | 0.1286 | 0.1659 |
| decoded/full source acquisition（load_source） | **659.8211** | **0.0011** |
| image selection / SourceInfo取得 | 0.0019 | 0.0008 |
| pipeline planner calculation（再plan時も合算） | 0.0569 | 0.0392 |
| Native座標・geometry descriptor生成/照合 | 0.0560 | 0.0372 |
| source retention（accept_preview_source） | 0.0084 | 0.0032 |
| その他（response組立・cache bytes集計等） | 0.0214 | 0.0065 |
| Native total | **660.0944** | **0.2539** |
| Backend operation total | 667.2388 | 6.4786 |

初回Nativeのmin–maxは658.8366–682.1268ms。Pan後のNativeは0.2129–0.2236ms、中央値0.2190ms。個別trial、各項目min/median/max、測定binary SHA-256は[証跡JSON](REGION_C3B_PLAN_TIMING.json)に保存。

## 処理の所在と再利用

実際のNative処理はmanaged patch内の`crates/mcp/src/region.rs::execute_inner`。desiredLongEdge 3990のjobは`SourceLevel::Full`を選ぶ。WholeはPreview source（上限2560）のため、その保持だけではFull cache hitにならない。

`load_source()`のFile分岐からfilesystem loader、`files::load_vec()` / `load_bytes_now()`へ進む。この境界にはwork gate、ファイル読込み、RAW decode、starting colour取得、demosaic/develop、highlight/colour変換、向き補正等が含まれる。Fullではbinned previewではなく全解像度の生成を要求し、通常のmosaicではAHDが選ばれる。今回の計測はこの**decoded/full source生成全体**を特定したものであり、659.82msをAHD単独の時間とは断定しない。I/O、decode、demosaic、colourそれぞれの内訳は未分割。

Planは`pipeline::plan()`を呼ぶが`RenderJob::run()`やGPU rendererは呼ばない。GPU preparation/uploadの実行はない。StagePool prepareもPlan returnより後のrender分岐なので、StageCache OFF/ONとこのsource cacheは別物である。

`accept_preview_source()`がFull decoded sourceを既存MediaCacheに保持し、2回目Planとその後のRegion Full/Panで使う。今回のrePlanはすべて`loaded`となった。sourceが残る範囲では別viewportの描画にも利用できる。native Planの入力にwindowはなく、Full geometryを返す。別Viewer windowそのものの実測は行っていない。独立document/processでの共有はなく、容量によるeviction、close、source変更等で再生成し得る。

GenzoRoomのtransport・scheduler・Region policyによる650msではなく、LightCraftのFull sourceを要求するpreflight経路にあるcold costである。GenzoRoom側も初回preflight待ち時間としてこれを観測している。新processでの反復を使う既存benchmarkでは、warm-up後の3回もそれぞれdocument-coldになる点に注意する。

## Openとの共通点

初期Whole sourceの取得と今回のFull source取得は、LightCraftのfilesystem/RAW decode・source development経路を共有する。ただしsource levelと出力準備が異なり、Preview cache保持はFull cache保持と同じではない。Open約2秒の内訳・重複量は今回測定しておらず、Open短縮量を推計しない。

## 次の対象と最小案

優先する価値があるのはFull decoded source生成と、寸法を知るpreflightにそれを必要とする依存関係。plannerの約0.057ms、GPU upload、StageCache budget、schedulerの調整で今回の約650msを解消する根拠はない。

将来の最小最適化案は、画素非依存の設定に限って、検証済みNative metadataから同じFull frame/geometry descriptorを返すpreflight fast pathを検討すること。auto upright等の画素依存処理やprofile、crop、orientation、丸めを無視してはならず、同等性を証明できない場合は現行経路へ戻す必要がある。これは提案のみで、今回実装していない。decode自体を改善するなら、次にFile load内のI/O / RAW decode / develop / colourを少数回計測してから対象を決める。

今回必要な実装変更は計測だけ。Native diagnosticsの任意`planTiming`、Backend validationとViewer metadataの任意`timing.regionPlan`への受渡し、Frontend strict validation、限定測定scriptを追加した。既存JSONは引き続き読める。公開Region geometry schema、policy、budgets、scheduler、transport、品質、cache設計、Recipe/History/保存形式は変更していない。README/CHANGELOGの変更は不要。

## 検証・制約

- Backend focused: 42 passed（Region / Viewer sequence / managed patch / artifact）。追加計測の伝播変更後はRegion/sequence 21件、最終manifestではpatch/artifact 21件を再確認。
- Frontend focused: 16 passed（benchmark parser / panel / diagnostic export）。TypeScriptチェックとproduction build成功。既存bundle size warningあり。
- Native focused Region: 9 passed。実行環境の一時領域制約で失敗した3件は通常権限環境で同じ対象を再実行し成功。
- 計測binaryのschema/capability、実Plan response kind/geometry/品質、実Region描画は既存adapterのstrict validationを通過。Full suite、長時間試験、Computer Use、ブラウザ実動作、NAS検証は実施していない。
- 計測用EXEは既存EXEが使用中だったため`target/release/lightcraft-c3b.exe`に分離。隣接receiptのmanifest tupleと実SHA-256を照合した。通常EXEは差し替えていない。新manifestを利用する開発環境では、既存プロセス終了後に通常のmanaged buildを更新するか、計測EXEへの`GENZOROOM_LIGHTCRAFT_EXE` overrideが必要。
- 外部Viewer window、source eviction後の再生成、RAW種類ごとの性能は未測定。今回の断定範囲はこのRAWとdocument/source cache状態。
