# LightCraft v0.14.0 upstream追随調査 — U1 / U2

調査日: 2026-10-26。対象: GenzoRoom `feature/lightcraft-integration`。**調査・文書化のみ。U3未実施。**

追記: **§1〜14はU1/U2完了時点の記録。現在のU3実装・自動検証結果は§15。** U3自動受入PASS、短いWindows画面受入は未実施。

## 1. Executive summary

**判定: 推奨B（価値はあるが、限定的なpatch再設計が必要）。** 次は独立したU3比較実験を推奨する。C3のsource/GPU cacheを独自に作り直す前にU3で経路別の効果を確かめる価値がある。ただし、U3の承認・実施前にC3 policyや現行engineを変更する根拠にはしない。

- v0.14はCPU medianの高速化、guided filterの一時allocation削減、GPU device lossからの安全なfallback、RAW対応拡大を含む。GenzoRoomへ届き得る改善である。
- **decoded Full originalの保持、GPU共有source、slot別running 1 + latest queued 1はv0.10ですでに存在する。** v0.14で初めて入った改善ではない。これだけで現行GenzoRoomとの差を説明できない。
- Desktopのdisplay-fit/Lanczos、pinch中のdisplay-fitサイズ保持、適応Draft判定の改善は主にegui側。CLI/MCP差替えだけでGenzoRoom Viewerへ同じschedulerが入るわけではない。
- geometryの`Frame`とwindow Planの中核は変更されていない。canonical Native geometry descriptor contract 2に相当する公開契約はupstreamに入っていない。現在のpatchを削除できる機能単位は確認できない。
- Dehaze、neutral tone map、parametric curve、camera/lens解釈などは画素を変える。**同一Recipeが読めることと、同一画素が得られることは別**。最大の受入リスクは画素互換性とengine tupleの扱いである。
- dry-runは失敗した。テスト移動とMCP文脈の競合に加え、GPU対応条件とdisplay-fitのsemantic conflictを確認した。apply成功だけでは受入できない。

機能単位13件の分類: **A=5 / B=8 / C=0 / D=0**。これは工数・hunk数ではなく、§6の固定13行の件数。Dなしは無変更適用可能・検証済みという意味ではない。

## 2. 正本・再現方法・調査境界

upstream: [storytold/lightcraft](https://github.com/storytold/lightcraft)。専用のignored checkout `.tmp/lightcraft-0.14-review`へcloneし、`v0.14.0`をdetached checkoutした。remote `ls-remote`のtag refとローカルcommitを照合した。main HEADを比較対象に使用していない。

| tag | commit |
|---|---|
| v0.10.0 | `a2a41383c4fd62fa85a46ccd00998639221f2d3c` |
| v0.11.0 | `ec0cda9a6f320e3b32f659f16718f7bce6c3f12f` |
| v0.12.0 | `479a05a0be4756be460859c4d42b4fbb7a60e99d` |
| v0.13.0 | `23e181283cb448205d865e8cd288b56afe987986` |
| v0.14.0 | `03c88c166c054c009db2a47187d59991f6232b85` |

GenzoRoom正本は[manifest](../../../native/lightcraft/manifest.json)と[managed patch](../../../native/lightcraft/patches/0001-native-before.patch)。実patch SHA-256は `6d2e4113001aa8d9661ac706857191b2286ca420e4987be987bf55b6462609dc` と一致。geometry descriptor=2、Before/Preview/Region各1を調査基準とした。

C2受入binary SHA-256 `7f4f76fd5c8989bf8439206c3bba778a753cf5e5b56359fb495cc14c4e914111` とC2-B/C2-C実機受入は既存記録を参照したもの。今回binaryを起動・再検証したという意味ではない。[C3-A baseline](REGION_C3_BASELINE.md)も既存測定として区別する。

再現するread-only比較:

```text
git rev-parse v0.14.0^{commit}
git ls-remote origin refs/tags/v0.14.0
git diff v0.10.0 v0.11.0 -- <path>
git diff v0.11.0 v0.12.0 -- <path>
git diff v0.12.0 v0.13.0 -- <path>
git diff v0.13.0 v0.14.0 -- <path>
git log --no-merges v0.10.0..v0.14.0 -- <path>
```

以下の`crates/`・`apps/`はupstream相対。根拠IDは§4の固定commitリンク＋symbolを指す。GenzoRoomの実装は明示的に別記する。release noteは索引として使用し、結論はtag間ソース差分と呼出し経路に基づく。Native test/build、pixel比較、latency/RSS/VRAM測定、実機・ブラウザ操作は今回行っていない。

## 3. version別の主要変更

ファイル数はrepository全体の各tag間`git diff --shortstat`。subsystemの表は関係する変更の要約であり、全変更の羅列ではない。導入commitの日付ではなくtagの到達可能性と隣接diffで所属を確認した。

| 差分 | 全体規模 | 統合に関係する主要変更 |
|---|---|---|
| 0.10→0.11 | 138 files / +5664 -764 | `SourceRef::Fit` Box→Lanczos3、`RenderJob::display_fit`追加、Desktop Fit描画のwhole-pixel配置。`DragScale`はslow判定を2 gestureで確定、期限・再試行を導入。RAWのchecked dimension、CRX tile幅、lossy JXL DNG transfer curve。MCP toolの上書き説明・destructiveHint、export format検証など |
| 0.11→0.12 | 227 files / +24057 -1182 | `SizeHold::display_fit`でpinch中の追加key変化を抑制。hidden/empty maskをplane選択から除外。neutral display tone map修正。GPU lost-device poll対策とPascal DX12 denoise修正。reduced LinearRaw DNGをthumbnailに限定、exportで排除。smart preview decoder facts保存／staleness修正。MRW、packed NEF/NRW、RW2、Kelvin/lens関連拡張 |
| 0.12→0.13 | 5 files / +71 -36 | Cargo version/lockと開発scriptのpath/引数検証、showcase、Sonar設定。今回のrender/source/Region/cache/MCP実装に差分なし |
| 0.13→0.14 | 351 files / +21784 -3452 | CPU median高速化、guided coefficient省メモリ、Dehaze暗部修正（CPU/WGSL）、parametric curve再実装、Auto straighten制限。diagnostic overlayのwindow描画とGPU soft proof拡張。Nikon sRAW、統合テストの`tests/it/`移動、CLI commands整列、各種library/UI/security変更 |

途中変更の注意: 0.11で導入したdisplay-fitがkeyへ寸法を入れるためpinchごとにrenderする問題を0.12でholdしている。0.11のclipping操作追加には同区間でrevertがあり、個別commit題名だけで最終機能を判断しない。0.14のoverlay/window拡張は最終tagの`overlay_supports_window`を根拠とする。

workspaceのMSRVはRust 1.90→1.95、quick-xml 0.38→0.41、chrono共通依存追加。licenseはMIT OR Apache-2.0を維持。U3ではtoolchain/lockも新基準として固定する必要がある。

## 4. upstream根拠索引

各リンクはv0.14固定commit。v0.10の同pathは§2の固定commitへ置き換えて比較できる。新規ファイル・移動先以外は前後双方を確認した。

| ID | source path / symbol | 確認内容 |
|---|---|---|
| S1 | [engine/media.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/engine/src/media.rs) `SourceLevel`, `MediaCache::{set_on_screen,enforce_budget,get_source,source_ref,forget}`, `Session::{accept,region_job_of}`, `SourceRef::load_source` | source選択・保持・invalidation・Arc・render後accept |
| S2 | 同上 `DecodedSource`, `ReducedLoader`, `Session::{thumb_job,export_job}`, `RenderJob::{with_display_fit,run}`, `fit_for_display` | 新しいsource由来情報と表示後段縮小 |
| R1 | [ui-egui/region.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/ui-egui/src/region.rs) `RegionView::is_current`, `plan`, `window_for`, `margin_for`, `SizeHold`, `DragScale`, `defer_window` | window、保持時間、Draftの判定 |
| R2 | [ui-egui/panels/detail.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/ui-egui/src/panels/detail.rs) `request_window`, `draw_window`, `show`, `overlay_supports_window`, `snap_fit_rect` | visible→window、old tile、表示fit、diagnostic overlay |
| Q1 | [preview/pool.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/preview/src/pool.rs) `JobPool::{submit,reprioritize}`, `Shared::busy` | 同slot排他と未開始置換。全期間差分なし |
| Q2 | [ui-egui/render.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/ui-egui/src/render.rs) `Renderer::request`, `Requested`, `shown_ids`, `discarded`, `render_failure_message` | stale draft採用、source accept、request時identity、failure log |
| C1 | [pipeline/lib.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/pipeline/src/lib.rs) `StageCache`, `plan`, `Plan::{geo,fixed_air,keep}`, `render_cached` | cache/Plan構造は同じ。CameraColor serdeとcurve公開などの変更 |
| G1 | [gpu/render.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/gpu/src/render.rs) `GpuStages`, `shared_source`, `SHARED_SOURCE`, `RETAIN_SOURCE_BYTES`, `render`, `Cx::flush` | source GPU copyの所有・保持・共有とpoll変更 |
| G2 | [gpu/ctx.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/gpu/src/ctx.rs) `Gpu::{poll,trim,finish_and_read}`, `DEVICE_LOST` | lost deviceを再pollしない／panic隔離／readback失敗 |
| G3 | [gpu/lib.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/gpu/src/lib.rs) `handles`, `try_render`, `shared_source_bytes`, `source_uploads`, `trim_pool` | soft proof対応条件・fallbackと既存診断 |
| F1 | [pipeline/geometry.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/pipeline/src/geometry.rs) `Frame`, `Frame::window` | 全期間差分なし。Native descriptor 2はここにupstream追加されていない |
| L1 | [pipeline/local.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/pipeline/src/local.rs) `median_row`, `total_key`, `guided_apply`, `guided_fast`, `plane_sigmas`, `base_key`, `frame_airlight` | CPU最適化・plane選択・Whole airlight |
| L2 | [pipeline/finish.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/pipeline/src/finish.rs) `curve_luts`, `finish_with` / [gpu/wgsl/finish.wgsl](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/gpu/src/wgsl/finish.wgsl) `main` | parametric curve、CPU/GPU Dehazeのveil制限 |
| M1 | [mcp/tools.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/mcp/src/tools.rs) `helper_tools`, `call_tool`, `annotations` / [mcp/headless.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/mcp/src/headless.rs) `Headless::export`, `Backend::call` | upstream tool schema・dispatch。既存render_preview aliasはあるがGenzoRoom拡張契約は不在 |
| M2 | [apps/lightcraft-cli/src/main.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/apps/lightcraft-cli/src/main.rs) `render`, `commands` | 出力formatを検証前に確定、commands id順整列 |
| T1 | [pipeline/tests_tone.rs](https://github.com/storytold/lightcraft/blob/03c88c166c054c009db2a47187d59991f6232b85/crates/pipeline/src/tests_tone.rs) `median_orders_special_values_and_ties_like_total_cmp` / L1 `sampled_coefficients_match_materialized_resizes` | 最適化の同値性を検査するupstream test。今回は未実行 |

補足根拠: `crates/raw/src/{lib,dng,jxl,tiffraw,kelvin_builtin,kelvin_presets,lens_metadata}.rs`、`vendor/{nef,mrw,rw2,cr2,crx,arw_lens,raf_lens}.rs`、`crates/engine/src/{smart,camera_profiles}.rs`、`crates/pipeline/src/{tone,curve,upright}.rs`、`crates/engine/src/cmd/{before,develop}.rs`。これらはdecoder・look・geometryの間接影響を追跡した範囲。`crates/develop`の全期間diffは空であり、settings構造の変更とrender解釈の変更を混同しない。

## 5. subsystem別詳細 — U1

### A. RAW source / decode lifetime

S1のThumb=512、Preview=2560、Full=原寸の選択構造は維持。`source_edge_needed`はcrop需要も考慮し、`region_job_of`はwindow幅ではなく仮想full寸法を使う。RegionはRAW ROI decodeではなく、Full全体decodeになり得る。

`MediaCache`のdecoded sourceは`DecodedSource`内の`Arc<Rgb32f>`で共有される。`SourceRef::Loaded`は既存source、`Fit`は大sourceから縮小、未保持時はworkerがdecodeし`Session::accept`がcacheへ戻す。`set_on_screen`の現表示Fullをbudgetから保護する処理、Full capacity、LRU/enforce_budget、`forget`・`clear_sources`・source content identityの基本構造はv0.10から存在し、0.14への変更ではない。常に全写真・全sourceを無期限保持する保証でもない。

新要素は`from_proxy`/`reduced`由来の区別、smart preview facts保存、reduced DNG thumbnail、FitのLanczos化。`ReducedLoader`は`thumb_job`だけに接続し、`export_job`はreducedなLoaded/Fitをuncached originalへ戻す。**通常のGenzoRoom Full Regionがreduced thumbnail decodeで速くなるという結論にはならない。** sourceのcamera tone/WB/lens解釈が変わるため、同じRAWからのnative寸法・fingerprintはU3で再確認する。

### B. Region / zoom / old-window retention

R1のwindow coreは256px snap、4.5% margin（最大3072）、native最大span6144／wasm3072、Wholeとの1.25比、`SizeHold`の0.25秒が基準。これらはv0.10から存在し、今回新規のGenzoRoom推奨値ではない。window位置がsnap/margin内で同一ならrender keyも再利用できる。新しいwindowに変わるとPlan geometryが変わり、前windowのspatial stageがそのまま使える保証はない。

`request_window`はgesture中に旧windowを拡大表示し、original未保持かつwindow job pendingなら重複decodeをdeferする。`draw_window`はphoto/full/settingsが適合する旧tileを次結果まで表示する。v0.14でvalidRegion coverage検査・GenzoRoom document/view generation契約が追加されたわけではない。slider中は旧look Draftを許容するupstream条件を、そのままGenzoRoom stale規則へ移植できない。

0.11ではFullのdisplay-fitとpixel snapでFit画質を改善。0.12はそのdisplay-fit寸法自体もgesture中＋quiet期間に固定し、追加key変動による再renderを防いだ。0.14はPointColor/HDR/Spotsなどdiagnostic overlayのwindow描画、proof/overlayをtile identityへ含める処理を拡張した。debug overlayは画像へ重ねる診断描画であり、GenzoRoomの計測パネルとは役割が違う。

GenzoRoom C0〜C2はcanonical Native geometry、bounded独立plan/render、context/prefetch、limited partial overlay、strict owner・generation、Whole fallbackを持つ。upstreamのegui制御をMCPがexportする契約はないため、`rawRegionAuto/Planner/Overlay`を残す。upstreamのhold概念を将来参考にしても、現行aggregation/quiet各180msやbudgetは変更しない。

### C. preview pool / scheduler / result adoption

Q1のファイルは全期間不変。同slotの未開始jobを`submit`で置換し、`Shared::busy`で同slot同時実行を防ぐ。workerは通常cores−1（2〜8）、priorityと同priorityの新しさで選ぶ。runningの処理を強制preemptする仕組みはない。全slot合計のrunning 1という意味ではない。

Q2はv0.10からinteractive viewに対し、現在表示より新しい成功Draftならsuperseded結果も採用しsourceをacceptする。連続sliderでいつまでも画像が出ない問題を避ける設計。0.14までにrequest時のsource identity保存、discarded数、thumbnail priority/Undo関連処理とfailure診断が追加されたが、基本scheduler刷新ではない。

GenzoRoom `rawRegionSchedule.ts::{replacePreviewPlan,takePreviewItem,finishPreviewItem}`はrunning 1 + latest pending **plan** 1（planは複数itemを含む）。`rawRegionDelivery.ts`はowner/current判定とstale rejectionを維持する。upstreamのslot並列・stale Draft採用は等価ではなく、Before/After pairやrevisionをまたぐ誤採用を避けるため、既存schedulerを保持する。Desktop側の低いtransport overheadと旧tile表示は軽快さの仮説になるが、v0.14差替えだけでは変わらない。

### D. StageCache / memory / admission

C1のCPU StageCacheはcapacity 2、source Arc identity＋Plan geo、linear stage key、plane半径／process／detail等で再利用する。G1のGPUもview別capacity 2とuploaded sourceを持つ。0.14で新しい総memory budget/admission/eviction機構へ置換されたわけではない。GenzoRoomの2-side `StagePool`、有限budget、実capacity／追加allocation／shared source reserveの計量は独自patchとして必要。

0.12のhidden/empty mask除外はplane生成条件を変え、不要cacheと画素影響を減らす。0.14のguided coefficient最適化は一時bufferを減らすが、retained stage構造を廃止しない。中央値処理の高速化もbase planeを再生成するときだけで、warm base hit時に同率の効果はない。

patchのCPU/GPU容量計量、source切替・geometry切替clear、OFF/tiny budget、Before/After合計とold/new共存の保守性は維持すべき。scratch削減を理由にbudgetを増やす・admissionを緩めるのは本工程外。memory減少候補はguided full-size係数2面の消滅。一方Lanczos fitや新しいdecoder factsの一時／保持memory、fallback時のGPU残存＋CPU再描画など増加可能性もあり、RSS/VRAMをsourceHostBytesやretained bytesと同一視しない。

### E. GPU / DX12 / shared source

G1の`GpuStages::source`は同じArcのuploadを再利用。96 MiBを超える大sourceでは`SHARED_SOURCE`にWeak host identity＋Arc device bufferを保持し、Before/Afterやwindow間で共有する経路がある。photo切替で旧copyを外し、一時的な旧新共存があり、idle時の`trim_pool`で解放する。**この共有・閾値・ownershipはv0.10から存在する。** cache OFF/ONなど実際の選択経路による違いはU3で`source_uploads`等を使って確認する。

0.12のG2はlost deviceを再pollしないようにし、poll panicをerrorへ変換する。readback失敗は正常画像にせずGPU失敗としてCPUへredoする。buffer destructorの二重panicによるprocess abort回避が主目的で、通常renderの速度向上率ではない。DX12 Pascal向け`gpu/nn.rs`・`wgsl/nn_conv.wgsl`のstore修正もあるが、RX580の通常Regionに同じ速度効果があるとはいえない。

0.14ではG3の`handles`第2引数が「proof全般」から「device profile proof」へ意味変更。通常soft proofはGPU化可能となり、WGSL finish/proof paramsも変更。既存patchの`develop_image`は`req.proof.is_some()`を渡しており、型は合うがunsupported理由分類が新条件とずれる。GenzoRoomの現行unproofed要求では直ちに同経路へ入らなくても、execution診断とGPU fallback試験の追随が必要。GPU source retentionの新導入による高速化と混同しない。

### F. geometry / native identity / Before

F1のFrame/native座標、crop/orientation/flip、perspective/distortion/CA/lens、window射影のcoreにtag間diffはない。pipelineのPlan geoはsampling/window/stage再利用の内部keyであり、GenzoRoomのcross-source-level canonical Native geometry IDとは異なる。`geometryId`/`nativeAspect`/descriptor contract 2の公開実装はupstream MCPにはない。

GenzoRoom patchの`preview::frame_metadata`は原本gridへ投影したfractional Native aspectをidentityへ含め、roundingされたbitmap sourceAspectをidentityから分離する。gain-only vignetteを除外し、pixelを動かすwarp/CA/lens等は含める。この責任は引き続き必要で、sampling StageCache keyまでcanonical IDへ統合してはいけない。

直接Frameが不変でも、RAW default crop/decoder facts、Sony/Fuji embedded lens、WB/camera profile、Auto straightenとcrop commandの意味は変わり得る。`pipeline/upright::level_degrees`は最大10°・3本以上の合意線へ制限される。`engine/cmd/develop.rs::set_aspect`は現cropの向き、custom ratioは指定向きを尊重し、`crop.set`に最小crop検証が加わる。単に「geometry差分なし」として受入を省略しない。

`RenderJob::with_display_fit`はrender/cache後にFull画像のみLanczos縮小しkeyへ表示寸法を混ぜる。実Plan sidecarをpatchで付けた場合、後段縮小した実PNGとの寸法が一致するとは限らない。現在のGenzoRoom headless jobはdisplay-fitを要求しないが、Desktop経由へのpatch接続・将来利用でsidecarの責任を明確にする必要がある。metadataを推測で縮小後に合わせない。

`engine/cmd/before.rs`自体は不変。import基準＋現在crop/orientationというBeforeの意味は維持される。ただしimport look/decoder/profile/tone mapの変更はBefore画素にも影響する。Afterのoptics/perspectiveをBeforeへコピーせず、fingerprint、kind、geometry capabilityを維持して再検証する。

### G. Highlights / Shadows — 性能claimの適用範囲

0.14 `540788818403df10d9eb661cbc34fbd4ab88ac5a`はL1 `median_row`のsorted f32/binary search/remove/insertを、`total_cmp`と同順のi32 key＋branch-free rank count＋`copy_within`へ置換する。medianの選択アルゴリズムの実装最適化であり、Highlights/Shadowsの現像式・V1/V2 processを変更する目的ではない。T1は±NaN、signed zero、infinity、tie、狭いplaneのbit列一致を検査する。ソース上の同値性根拠であり、今回GenzoRoom実RAWのbit一致を測定したわけではない。

恩恵は**CPU、V2のbase medianが必要、base cache miss**のとき。Regionも同じCPU pipelineなので実work windowのbase再計算に効き得る。GPU medianは別実装でこの変更の対象外。V1やdetail半径0、tone無効、retained base hitでは対象仕事がない／少ない。releaseの約2倍という値をNative全体・MCP round trip・Viewerの約2倍へ外挿しない。

別commit `8b069bf87eaaf1d7189a0a2d77979f43f3a3261d`は`guided_fast`のfull-size a/b係数plane生成を、32行band＋4行cacheからの同じseparable bilinear演算へ置換する。局所scratchとwidthに依存させ、2 full-size係数面のallocationを回避する。L1のmaterialized reference比較testで積和順を保つ根拠がある。CPU Highlights/Shadows/Clarityなどguided経路のcache miss時に適用候補。GPUやcache hitの直接高速化ではない。

### H. Dehaze

0.14 `9122443f2`のL2は、blurred dark channelから推定したveilをpixel自身のminimum channelで上限化し、air/air_preのzeroもguardする。CPUとWGSL双方が変更される。明部に隣接する暗部で引き過ぎて黒潰れする問題を修正し、画素出力は意図的に変わる。局所Dehazeもfinishの同じ処理を通る。

Whole proxy由来の`frame_airlight`、Plan `fixed_air`、work window/contextと`keep`は維持。新しいairlight推定やWhole/Region完全一致保証への置換ではない。`tests_window.rs`の暗部fixture追加は有用だが、C1の最大3 LSB差が解消した証拠ではない。境界blur/context、CPU/GPU、Full/Draft、airlightと暗部の組合せをU3で再計測する。差の増減も今回未測定。

### I. CLI / MCP / safe diagnostics / receipt

M1のupstreamは`render_photo`/`export`等のhelper toolsを維持する。`call_tool`にはv0.10から`render_preview`という互換aliasも存在し、`id`/`format`/`max_side`を`render_photo`へ渡す。ただしGenzoRoomのBefore・strict quality/contract拡張、独立`render_region_preview`、typed frame/StageCache/execution metadataは追加されていない。名前の存在を同等機能と判定しない。MCP backendの増分は主にsocket/child test直列化とidle reconnect試験。CLIのrender format/bitDepth検証、commands一覧id整列、export `fit`追加は、GenzoRoom preview契約の代替ではない。

0.14では`gpu/tests/equivalence.rs`→`gpu/tests/it/equivalence.rs`、`mcp/tests/e2e.rs`→`mcp/tests/it/e2e.rs`へ移動し、各`it/main.rs`から統合する。patch target・manifest・テスト検出の追随が必要。MCP追加schemaはupstream側のtool metadata/annotationsを落とさない形で再接続する。

Q2の`render_failure_message`はrequest時sourceとraw errorを含むupstream loggerの文脈強化であり、GenzoRoomのsafe structured loggerと同等ではない。stdlib/log stderrを自動収集せず、固定error mappingとallowlist metadataの境界を残す。GenzoRoom側`backend/lightcraft_runtime.py`の`process.artifact` hash診断と`native/lightcraft/build.py::receipt`は外側の管理で、upstreamに置換先がない。

## 6. managed patch機能分類 — U2

A=引き続き必要・ほぼそのまま、B=必要・軽微な追随または限定した接続再設計、C=upstream同等機能で削除／縮小可能、D=大きな再実装／設計判断が必要。本表は静的判定であり、build/pixel/contract受入を代替しない。

| 機能単位 | 分類 | managed側 path / symbolとv0.14根拠・必要作業 |
|---|---|---|
| 1. CLI/MCP tool追加 | B | patch `mcp/{tools,backend,lib}.rs`、`helper_tools`/`call_tool`。M1のschema/annotations文脈を保持して再接続。既存render_preview aliasに同等の拡張契約はない |
| 2. Whole Preview | B | patch `mcp/headless.rs::adaptive_render`、S2/M1。quality/contractは必要。headlessはdisplay_fitなしを保持し、後段縮小とframeの境界を明確化 |
| 3. Before Preview | A | patch `headless.rs` Before分岐、`before_settings`、upstream `cmd/before.rs`不変。kind/fingerprint/schema保証はupstream helperにない |
| 4. Region plan/render | A | patch `mcp/region.rs::{call,execute_inner}`。R1/R2/C1は内部windowであり公開plan/render契約を代替しない。generation/owner/limitsを維持 |
| 5. Native metadata | B | patch `pipeline/lib.rs::Rendered.frame`、`geometry.rs::native_size_at`、`engine/media.rs`のstand-in初期化。S2のrender後縮小とmetadata寸法の関係を検証。decoder/lens factsも再確認 |
| 6. geometry descriptor contract 2 | A | patch `mcp/preview.rs::frame_metadata`、`GEOMETRY_DESCRIPTOR_CONTRACT`。F1に同等Native IDなし。canonical aspectとsampling keyの分離は必要 |
| 7. StageCache diagnostics | B | patch `preview.rs::StagePool`、`pipeline/lib.rs`容量計量、`gpu/render.rs::GpuStages::{allocations,additional}`。C1/G1/L1。scratch削減後も実capacityとreserveを確認、budget変更不要 |
| 8. source diagnostics | B | patch `region.rs::execute_inner`、`engine/media.rs::accept_preview_source`。S1/S2の新DecodedSource factsを失わずaccept/WB保護を維持。Full保持診断は必要 |
| 9. GPU diagnostics | B | patch `engine/media.rs::develop_image`、`pipeline::Execution`、`gpu/lib.rs`。G2/G3のdevice-proof条件にreason判定を合わせ、lost/readback失敗とCPU結果の整合を確認 |
| 10. process artifact / receipt | B | GenzoRoom `build.py::{prepare,receipt,probe}`、`backend/lightcraft_runtime.py`。upstream代替なし。new tuple/digestと実binary照合、version依存probe/共有fixture gateの追随が必要 |
| 11. error mapping | A | patch `preview.rs::error` / `region.rs::error`、Backend bounded validator。M1/G2の内部例外文を契約へ漏らさず固定codeへ変換。新例外の境界試験は必要 |
| 12. safe structured diagnostics | A | patch `region.rs` diagnostics / `preview.rs::StagePool::finish`、GenzoRoom runtime logger。Q2のraw path loggerを採用せず既存privacy境界を維持。upstream perfカウンタと公開safe診断は非同等 |
| 13. test / probe support | B | patch `gpu/tests/equivalence.rs`, `mcp/tests/e2e.rs`, `region/tests.rs`、GenzoRoom native probe。移動した`tests/it/`とmain登録へ追随。新Rendered初期化・Rust 1.95・新tuple対応を確認 |

**A=5、B=8、C=0、D=0。** C候補の「source cache / GPU retention / scheduler / StageCache」は元からupstream依存であり、今回新規にGenzoRoom patchを不要にした機能ではない。diagnostic overlayやperf数値は契約・transport計測を代替しない。Dへ上げる条件はU3でdescriptor維持不能、Plan/PNG整合不能、有限budgetやBefore保証を失うことが判明した場合。

### 6.1 dry-run結果とsemantic conflict

ソース理解後、clean v0.14 checkoutで既存patchに`git apply --check`のみ実施（exit 1）。実適用・patch修正はしていない。

- 旧`gpu/tests/equivalence.rs`、`mcp/tests/e2e.rs`が存在しない。
- `mcp/headless.rs`と`mcp/tools.rs`のhunk contextが不一致。
- それ以外のhunkにcheck errorが出ないことはsemantic互換の証明ではない。特に`handles(..., proofed, ...)`の意味変更、display-fit後のframe sidecar、DecodedSource facts保持を別に評価した。

## 7. 交換可能な依存コンポーネント設計の評価

**境界は成立しているが、無条件のbinary交換ではない。** MCP能力検査、独立Region contract、strict validator、manifest/digest/receipt、実binary SHAがnative rendererとアプリを隔離する。CPU/GPUの式をGenzoRoomへ複製せず、source/Plan/StageCacheをupstream所有のまま使う構造も有効。

一方、現行adapterは意図的にv0.10 engine tupleを固定する。`backend/lightcraft_raw.py`の`ENGINE_COMMIT`、`DevelopSnapshot`、restore/recipe検証やBefore keyにはversion/commitを含む。新engineの読み替えを単純に許すと、同じ保存Recipeの見た目・History復元が変わり得る。U3はside-by-sideの一時試験adapter／fixtureで比較し、製品の保存データを移行しない。

また`native/lightcraft/build.py::prepare`の共有Region artifact照合には`spec['version'] == '0.10.0'`条件がある。manifestだけ0.14へ変えると共有schema一致gateを迂回するため、U3のbuild/probe追随項目に明示する。これは今回の調査で見つけた**更新時の検証リスク**であり、現行0.10のgate不具合ではない。

「依存交換」の合格は公開Before/Preview/Region 1とdescriptor 2を新tupleで維持し、旧データ保持と失敗境界が確認できること。今回その動的合格を宣言していない。

## 8. 本家Desktopが軽い理由とperformance評価

以下はコードからの到達可能性と既存C3-Aに基づく仮説。今回v0.14の性能実測ではない。

| 境界 | v0.14更新で期待できるもの | GenzoRoom transport/owner側に残るもの |
|---|---|---|
| Native render時間 | CPU median、guided scratch削減。設定・process・cache miss依存 | GPU/CPUの選択、実work window面積、呼出回数。end-to-end改善率は未測定 |
| source decode/cache | RAW対応・reduced thumbnail・facts改善。Full保持自体は既存 | cold Full decodeとsourceを失う条件の計測。通常Regionへのreduced decode効果はなし |
| GPU source lifetime | lost-device安全性。共有source保持自体は既存 | Arc/source切替、cache OFF/ON、idle trimとactual upload回数の確認 |
| preview scheduler | Desktop DragScale/fit hold改善 | Frontend aggregation/quiet、Backend admission、MCP直列化。CLI交換では変わらない |
| Region/window reuse | Desktop overlay/proof identity拡張 | GenzoRoom validRegion/limited/pair/generationの再利用判定。既存機構を保持 |
| PNG encode | 今回の関連差分にpreview PNG転送を除去する変更なし | Desktop textureに不要なPNG encode/file read。新しい画像内容で圧縮量が変わる可能性はある |
| Base64/MCP | 独自契約の代替transportなし | Base64膨張・JSON line・pipe往復・decode/validationを継続 |
| Backend HTTP | upstream外 | Native待ち、validator、body/HTTP deliveryの費用を継続 |
| Browser decode | upstream eguiの変更は適用されない | PNG/bitmap decode、URL所有・破棄、decode完了待ちを継続 |
| WebView overlay adoption | Desktopの旧tile描画は参考 | pair待ち、stale判定、adopt/rebind、描画frame待ちを継続 |

C3-Aのwarm 1:1ではNative work CPU109.8ms / DX12 78.4ms、MCP往復189.8 / 165.2ms。これは旧binaryの単発値。実ユーザーPanのNative work中央値72.1msに対しtransport+readback中央値132.5ms、Backend validation35.0ms、decode17.2msが別境界で観測済み。重複し得る中央値を足さない。Native timerはPNG書出し前で止まり、残差はencode、I/O、Base64、transport等を含むためPNG単独時間と呼ばない。

したがって、CPU kernel改善だけでPan終了→Full採用851ms等の待ちが同率に縮む根拠はない。C3はtransport/queue/adoptionを分離して継続する必要がある。v0.14は比較対象を更新する候補であり、aggregation/Region budget最適化の答えではない。

## 9. 更新riskと受入条件

| リスク | 静的評価 | U3で閉じる条件 |
|---|---|---|
| managed patch conflict | 中。実dry-run失敗、test移動、MCP文脈、意味変更 | 専用patch全差分監査、部分／重複適用拒否、target一覧とdigest照合 |
| pixel output change | 高。Dehaze、neutral tone、parametric curve、RAW/WB/profile/lens | 同RAW/同RecipeのCPU/DX12比較。意図的変化と回帰を分離し旧binaryを保持 |
| geometry regression | 中。Frame不変でもdecoder/lens/crop command/display-fitの間接変更 | 原本／canonical Native、source level、crop/orientation/flip/perspective/distortion/CA/lens行列 |
| Region contract | 中。独立公開契約は依然patch責任 | bounded plan/render、actual F/window/validRegion、mismatch/oversized拒否、stale/pair |
| StageCache | 中。layoutは概ね維持、plane選択・scratch変更 | OFF/ON/tiny、repeat、source/window/quality切替、2-side合計、Full画素一致 |
| GPU fallback | 中。poll保護改善とproof条件変更 | fault/lost/readback→CPU正常結果、execution理由、再利用禁止、process継続 |
| memory | 減少候補あり、peak増加の可能性も残る | cold/warm/反復/切替/closeのRSS/VRAM、source host/device/stage/pool/retiredを区別 |
| Recipe互換性 | schema差分なしでもlookと固定tupleは非互換になり得る | 旧Recipe保持・新tupleの比較方針。製品への自動移行をしない |
| Before互換性 | settings選択は不変、画素・fingerprintは再確認 | import baseline、kind/schema、After optics非転写、Before失敗時After継続 |
| 将来Export | format/bitDepth/fit/reduced-source除外が有用。一方previewだけでは保証不能 | original full source、高bit depth/color/HDR、dimensions/widthHeight、出力formatを別受入 |
| toolchain/probe | Rust1.95、test layout、0.10限定fixture gate | 新toolchain固定と旧0.10 build保持。全native probeが新tupleで実際に動くこと |

## 10. backport候補

実backportは行っていない。各候補も新patch digest/binary/receiptと比較受入が必要。

| 候補 | 評価 | 理由・依存 |
|---|---|---|
| CPU median (`540788818`) | 高優先候補 | 小範囲、同値性testあり。CPU V2/base missに限定。GPU・全体2倍を期待しない |
| guided係数allocation (`8b069bf87`) | 高優先候補 | CPU scratch減少。reference同値性とtiny/narrow/Draft/Full/Regionを確認。retained budget設計は維持 |
| GPU poll安全性 (`389a2cdd6`) | 高優先候補 | 通常速度よりprocess継続／fallbackの改善。ctx/readback/destructor/flushを一体で追随する必要 |
| Dehaze (`9122443f2`＋関連test) | 条件付き候補 | 暗部品質修正。CPU+WGSL+window testsを一緒に扱う。画素変更を許容する判断が必要。3 LSB解消策とは断定しない |
| source cache / Full lifetime | 新backport対象なし | 必要な保持機構はv0.10に存在。現行経路のretention欠落が実証されれば別修正として調査 |
| GPU shared-source retention | 新backport対象なし | v0.10に存在。upload回数・idle trim・cache経路の実測が先 |
| scheduler / zoom quiet | Native更新の直接backport優先度は低 | pool不変。display-fit holdはegui固有。GenzoRoomへはowner/transportを踏まえた独立設計が必要 |
| hidden/empty mask plane除外 | 中候補 | 不要planeとClarityへの影響を修正。ただし見た目の変化を伴い得る |
| reduced DNG thumbnail | 対象RAW/thumbnail要件次第 | Full Regionの高速化ではない。export original保護とfacts管理の依存が大きい |
| diagnostic overlay / frame perf | 低（現scope） | Desktop機能を取り込んでもHTTP/decode/adoptionの診断は置換されない |

複数backportを積むほど独自保守面積が増える。まずU3で0.14全体の互換性コストを把握し、look変更を受け入れられない場合にmedian/guided/GPU安全性の限定backportを選ぶ。

## 11. 推奨判定・C3との順序

**推奨B。U3比較実験は実施する価値が高い。** Aではない理由は実patch衝突、GPU conditionとmetadataの意味調整、test/probe/tuple追随があるため。D相当のpipeline再構築を要する証拠はなく、C分類で廃止できる公開契約もない。

最大の性能benefit候補はCPU base missでのmedian＋guided scratch削減。DX12優勢の実機ではGPU source retentionの新規改善がないため、体感Pan/Zoom改善は未確定。最大のcompatibility riskは同Recipeの画素変化と、旧保存engine tupleを新engineへ誤って読み替えること。

C3の独自source/GPU cache最適化を大きく進める前にU3の結果を得ることを推奨する。transportとadoptionの調査結果はupstream更新と独立して再利用できる。現行C3 policyは据え置き、更新実験の実行は別指示を待つ。

## 12. U3案（計画のみ・未実施）

1. v0.14固定commitの新専用checkoutとRust1.95を用意。旧0.10/C1/C2 binary・receiptを保持し、製品設定・DB・Recipeへ書かない。
2. managed機能13項目を新基準へ再接続。test移動、tool schema、display-fit/sidecar、GPU device-proof判定、DecodedSource factsを追随。新managed patch、target一覧、digestを独立作成する。
3. `build.py`のversion限定gate/probeとadapter tupleの比較用経路を準備する。共有schema/fixture、strict error mapping、safe loggerを保持。部分適用・二重適用・余分なdiffを拒否する。
4. native test/buildを行い、新binary自身のtools/list、Before/Preview/Region各1、descriptor2、kind/fingerprint/frame/PNG実寸、SHA-256を照合し新receiptを発行する。version表示だけで承認しない。
5. same RAW/same Recipe、fresh CPU / independent DX12、cache OFF/ON/tiny、Whole1024/2048、Region plan/render、Draft/Full、Before/After pairを比較する。新旧processを混在させずsource/tupleを固定する。
6. geometry行列とsource-level/rounding境界、Whole→Region→Whole、pan/zoom/戻り、source変更、close/reopen、invalid/stale/oversized、GPU fallbackを確認する。Full cache OFF/ON画素一致と新旧画素差は別の判定軸にする。
7. median有効/無効、V1/V2、guided、Dehaze暗部、tone curve/profile/lensのfixtureで差を帰属する。Dehazeの旧最大3 LSBは同条件を再現して比較し、更新後の閾値を勝手に緩めない。
8. cold decode、Native work、PNG/transport残差、Backend validation、HTTP/decode、pair/adoptを分離し、反復分布とRSS/VRAM、retained capacity、upload count、cache hit/missを採取する。C3-Aと同条件の値を比較する。
9. 必要なGenzoRoom adapter/runtime/Recipe/History/Region回帰と関連Frontend検証を実施。Windows実機／NAS／Firefox受入はユーザー工程。比較結果をreview後、製品更新・限定backport・据置を判断する。

## 13. 未解決事項・動的検証への持越し

- 0.14上でのpatch build、binary契約・pixel一致・latency・peak memoryは未検証。全13行の分類は静的見積り。
- CPU最適化が対象RAW/Recipeのbase miss率にどれだけ寄与するか、DX12で体感が改善するかは不明。
- display-fitを使うpatched Desktop経路のframe sidecar契約はU3で決める。headlessで使わないことを全経路で検証する必要がある。
- 新tupleで旧Recipeを再現するか、旧engineを残すかという製品互換方針は未決定。今回保存データを変えていない。
- Dehaze差の解消、RAW/lens/WB差、GPU loss時RSS/VRAMはソースだけでは確定できない。

## 14. 調査結果の監査・検証記録

初回監査では次のMedium相当の**調査上の見落とし候補**を拾い、上記本文・U3条件へ反映した。製品修正を実施したという意味ではない。

| 発見点 | 修正文書 | 再監査の扱い |
|---|---|---|
| apply可能hunkでも`handles`のproof引数の意味が違う | §5E、§6 GPU diagnostics | 型／apply可否で互換としないよう修正済み |
| display-fit後PNGと実Plan sidecarの責任が曖昧 | §5F、§6、§12 | headless未使用とDesktop潜在riskを分離済み |
| 0.10限定共有fixture gateと固定engine tuple | §7、§9、§12 | manifestだけ変更する案を排除しU3前提へ反映済み |
| Frame差分なしからgeometry無影響と結論し得る | §5F、§9 | RAW/lens/crop command/Auto straightenの間接影響を追記済み |
| upstreamに既存render_preview aliasがあることの区別不足 | §4 M1、§5I、§6 | tool名の不在という表現を修正し、aliasとGenzoRoom拡張契約を明確に分離済み |

最終監査は、正式tag/commit、隣接4区間、upstream originalとmanaged差分の区別、source path/symbol、A/B/C/D件数、性能経路、privacy、未実施範囲を確認するもの。release noteだけ、main HEAD、apply成功、同率高速化、C3 policy変更を根拠にした結論は採用していない。

文書検証: `git diff --check`、新文書のprivate absolute path／実assetId／token／sourceId等の混入確認、固定commitでのpath/symbol照合、内部整合の確認を実施。固定commitへのsourceリンク17件とsymbol63件を機械照合し、分類13行（A5/B8）も集計照合した。最終的な未修正High/Mediumの**調査文書findingは0**。上記U3受入riskは未実行のまま明示して残す。

今回変更は本Markdownのみ。production code、managed patch/manifest、binary、receipt、C2/C3既存記録、README/CHANGELOGは変更していない。Native/Frontend/Backend test、build、browser動的検証を成功したとは報告しない。

## 15. U3実装・検証結果（2026-10-26）

### 15.1 判定・artifact

**U3移行候補の自動受入PASS。** v0.14全体へ追随し、個別backport・大規模benchmark・C3 tuningは行っていない。正式なWindows画面・画質受入はユーザーの短い確認待ち。U1/U2の「実装未検証」という制限は本節の試験範囲で更新するが、過去のC2/C3受入記録は書き換えない。

| 項目 | 新基準 |
|---|---|
| upstream | v0.14.0 / `03c88c166c054c009db2a47187d59991f6232b85`（main未使用） |
| source | `.tmp/lightcraft-0.14`、独立clean適用検証は `.tmp/lightcraft-0.14-verify` |
| patch | `native/lightcraft/patches/0002-v0.14-native-contracts.patch`、22 targets |
| patch SHA-256 | `d0d7653a92ad7db0af526d4595a54356cd0b0480f7757bf2b60487030a7582d3` |
| EXE | `.tmp/lightcraft-0.14/target/release/lightcraft-cli.exe` |
| EXE SHA-256 | `3d41aff1cf70be79f5fdf54061ce51efc3988e02b4ff354d91423a7113e9423a` |
| receipt | EXE隣接 `lightcraft-cli.genzoroom.json`。実EXE hash／manifest／probe成功を照合 |
| contracts | Before 1 / Preview 1 / Region 1 / geometry descriptor 2 |
| evidence | [安全化結果・receipt summary](LIGHTCRAFT_0_14_UPGRADE_RESULT.json) |

旧patch `0001-native-before.patch`、旧manifest `versions/0.10.0.json`、C1/C2 binary/receiptを保持した。旧patch digestとC2 EXE実hashはU1/U2基準のまま。archived manifestで旧managed sourceの再検証が成功し、新patchも独立clean checkoutから`--apply`→完全diff検証に成功した。旧／新どちらも部分適用・余分なsource・二重適用を許容しない。

### 15.2 主要な再接続

- 13分類の機能を保持。MCPの新annotationsとschema文脈、`tests/it/`への移動を追随した。旧patchで追加した91個の関数／test symbolの存在も照合し、テストを削っていない。
- DecodedSourceの新factsを保持して既存run/acceptとWB保護を維持。canonical IDのsource/original/nativeAspect/crop/orientation/flip/coordinate-moving warp規則を変更していない。sampling／StageCache keyは別のまま。
- post-Plan `display_fit`がbitmapを縮小した場合は`Rendered.frame=None`とし、旧Planを実PNGのgeometry証拠として使わない。headless Whole/Regionはdisplay-fitを要求せず、実Plan sidecarを維持する。
- 追加GPU回帰により、upstream engineの`develop_image`にも旧`req.proof.is_none()` gateが残ることを検出した。新device-profile proof判定をGPU呼出しとexecution reasonで共有し、matrix proofのGPU成功／device-profile proofのunsupportedを検証した。通常RAW Previewのpolicy追加ではない。
- median/guided filter、Dehaze、decoder/lens/profile、GPU loss/readback等はv0.14の実装をそのまま取り込む。現像式をGenzoRoom側へ複製していない。
- `build.py`はversion gateを共有Region契約の必須照合へ置き換えた。HEAD＋Cargo version、patch digest/targets、source全diff、contract整数型、actual binary SHA、実probeを検証する。旧manifest指定も対応し、整数1をJSON trueで偽装するreceiptも拒否する。

### 15.3 Recipe／Historyとversion表示

**旧tupleによる事前拒否方針は撤回。** 永続RecipeはAsset ID・source content hash・`lightcraft` engine name・対応settings schema（現在1）を照合し、engine version／commit差だけでは拒否しない。v0.10 settingsもv0.14へそのまま渡し、復元可否は現在engineの実restore・readback結果で判断する。成功後は通常編集でき、次回保存はv0.14の現tupleで別行に保存する。旧Recipeの事前変換、偽装、migrationは行わない。source/schema/engine-name不一致は従来どおり拒否し、native restore failureは実エラー境界へ落とす。Historyと同一実行snapshotのstrict ownershipは維持する。将来engineとの完全な画素互換は保証しない。新readbackとBefore keyは引き続きv0.14を識別し、Recipe/schema/DB versionは変更しない。

2026-10-26の互換修正後、v0.10→v0.14のrestore・document open・現在tupleでの次回save・native rejection・source/schema guardとRecipe/History storeを含むBackend focused 222件、RAW画面53件、Frontend TypeScript checkがPASS。今回の変更に対する未修正High 0／Medium 0。

Backendのversion/commitはmanifestを正本とし、Frontendのstrict identityも`sync_identity.py`で同じmanifestから生成する。将来版のために複数のproduction codeのversion literalを書換える運用にはしない。SettingsはImmich情報の下へ簡潔に版を表示する。版を表示できるのは、ready generationのhandshakeと実EXE SHA、全patch tuple、整数contract、隣接receiptが一致する場合のみ。未接続／欠落・不正metadata／refresh前の古い応答では版を推測しない。実binaryをBackend managerから起動し、`artifact.version=0.14.0`、descriptor2、Region1のcapability応答も確認した。

RAW編集・Recipe tuple発行自体も同じartifact検証を必須にした。versionだけ一致する未検証processは`raw_unverified_artifact`でimport前に拒否し、固定commitを保存情報へ推測で付与しない。JPEGやBackend起動の可用性とは分離する。

receipt I/OはEXE hashingと同じbounded daemon inspection ownerに置いた。完了監査でdefault executorの追加I/O待ちを避けるよう修正し、stalled receipt読取りでもevent loop／shutdownを保持しない回帰を追加した。Windows frozen packageへmanifestを収録する。DockerはNative未接続のままで、版を偽装しない。

### 15.4 実RAW・画素・短いsanity

既存private実RAW harnessを使用。RAW・path・asset/source identity・Recipe本文は追跡ファイルへ入れていない。

- Whole 1024、adaptive final候補1472、2048、Preview→Full source、canonical Native 4064×3056、production C0 planner経由Region plan/renderがCPU/DX12双方で成功。
- Draft/Full、Whole Before、Region Before、Before/Afterのread-only整合、cache OFF/ON、source switch後のFull再描画、settings不変を確認。Whole/Region/Beforeの同engine Full cache ON/OFF画素は一致。
- CPU/DX12のWhole／Region／Beforeで最大各1 LSB。PIL decodeと既存strict PNG/metadata validatorを通し、geometry/orientation/crop contractの異常は検出しなかった。実写真の最終色・見た目の判断は短いWindows確認に残す。
- v0.10との画素一致・性能比較は行っていない。Dehaze、neutral tone、parametric curve、RAW/WB/lensのcross-version差はupstream変更として存在し得る。旧C1 Whole/Region最大3 LSB差が解消したとは判定しない。
- Native processはCPU/DX12のharness終了時にexit 0。APIのclose/cancel/reapingとsource所有も自動試験で確認した。

以下は各backend 1 process、同一RAWでの**sanity**。端数を丸めたMCP呼出し＋validator境界であり、kernel単体時間・統計・旧版比較ではない。

| 項目 | CPU | DX12 |
|---|---:|---:|
| cold Whole1024 | 933 ms | 911 ms |
| warm Whole2048（cache ON） | 406 ms | 333 ms |
| warm Region 3回 | 273 / 263 / 248 ms | 273 / 267 / 297 ms |
| 同RSS概数 | 230.4 / 230.7 / 231.0 MiB | 646.6 / 654.0 / 654.0 MiB |

hang／OOM／反復の明らかな遅化・異常な増え続け方はこの短い範囲では観測しなかった。長時間leak・VRAM精密追跡を証明したものではない。StageCache admission／実capacity／shared source／OFF/tiny後継続の既存probeも維持し、実RAW Regionのcache admission拒否時にも正常描画を確認。512 MiBは既存の試験用budgetであり、製品budgetを変更していない。rho .85/.95、aggregation180ms、context16、prefetch64、F256刻み、Region2MP、Whole adaptive policyも据え置き。

### 15.5 試験・監査

| 範囲 | 結果 |
|---|---|
| Native MCP unit / integration | 74＋11 PASS、helper 1 ignored |
| Native engine独自回帰 | 3 PASS（display-fit、single decode/accept、execution/fault/proof） |
| Native pipeline | 208 PASS、既存helper 2 ignored |
| Native GPU integration / simulated lost poll | 20＋1 PASS、capability probe 1 ignored。実DX12は別binary probeで成功 |
| Backend関連回帰 | 最終のRAW/Recipe/History/Region/capability/receipt/owner/adaptive関連457件PASS。別の管理／MCP／History store／packaging176件PASSも実施。scope間に重複あり、合算しない |
| Frontend関連回帰 | 18 filesの現行535件相当を検証。初回246＋288、追加互換メッセージ1件。最終Settings＋RAW画面78件もPASS。無関係な全suiteは未実行 |
| static / build | repository Python3.14、TypeScript、Frontend production build、Native release build、manifest/receipt/targets、private混入・diff検査 |

途中の失敗は解決済み。sandboxのsocket/TEMP制限はfocused再現後に通常Windows権限で実行した。MCP discovery testは混在separatorをfixture側で絶対path正規化した。Backendのキャンセル試験はbootstrap eventの再利用と、20ms sleepが20ms shutdown deadlineに競合する問題があり、実際の新render開始とchild reapingを明示的に保持する試験へ修正した。HTTPキャンセルでrenderが保持され、Nativeがreapされるまでsourceが削除されない条件を削っていない。製品のcancel/close方針は変更しない。

監査ではtag固定、managed diff完全一致、旧artifact保全、tuple非偽装、contract/geometry維持、strict validator、Settingsと実binary、privacy、C3非変更を確認した。GPU gate、receipt I/O owner、未検証processへの固定commit付与を防ぐMedium findingは修正・再検証済み。**未修正High 0／Medium 0。** 新しいpixel/latency baselineの性能優越は合格条件にしていない。

既存のcraft-fonts未同梱warning、upstream Windows testのunused variable、incremental hard-link→copy、Frontend chunk-size、Node TypeScript stripping実験warningは記録し、無関係な修正は加えていない。full Docker release Smoke Test、Windows配布installer build、実ブラウザ操作、NAS／Firefox受入は行っていない。

### 15.6 ユーザーのWindows確認

通常のWindows開発起動ではenv指定なしでmanaged artifactを自動検出する。`GENZOROOM_LIGHTCRAFT_EXE`は旧版検証・別build試験のoverride用途。Backend再起動後、Settingsの採用版、RAW Fit、100% Region、Pan、Before/After、数枚の現像結果を短く確認する。v0.10 Recipeのbest-effort restoreと「RAW編集をリセット」後の初期状態reopenも確認する。これを経てv0.14の実機受入を確定する。自動download・旧版自動切替・NASデプロイ・release作業には進んでいない。

### 15.7 RAW編集リセットとWindows開発artifact探索

persisted Recipe restore failureからの復旧操作として、Windows RAW APIにAsset単位の編集リセットを追加した。開いているdocumentのownerを検証し、session close成功後だけ、Recipe／History／step／current save receiptを1 transactionで削除する。JPEG編集、Export、Immich metadata、元RAWには触れず、同じAssetを現行engineの初期settingsでreopenする。通常のRAW History paneからも同じ確認付き操作を使える。失敗境界はsession close、SQLite、reopenに分かれる。

env未指定のWindows開発では、`.git`を持つ非frozen checkoutに限りmanifestと同じ`.tmp/lightcraft-<major.minor>`候補を探索する。candidateは実行時のreceipt／SHA／manifest／contract検証が通った場合だけRAW capabilityとSettings版表示に採用する。明示env overrideは探索より優先し、同じstrict検証を受ける。frozen配布版は`.tmp`を探索せず、bundled artifact方式へ独立して接続できる。

開発中は過去LightCraftとの完全互換・画素一致を保証しない。persisted RecipeはAsset/source identity、engine name、対応schemaが一致すればversion／commit差だけで拒否せずbest-effort restoreする。読めなければmigrationなしでRAW編集リセットから現行engineの初期状態へ再開する。追加focused testsはresetのtransaction/API/reopen/現tuple保存、およびdiscoveryの優先順位・候補なし・artifact attestationを確認する。詳細結果は今回の実装報告に記録する。
