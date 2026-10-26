# C3-C: Region Planのmetadata-only成立性（2026-10-26）

## 1. 判定

**B: 条件付きでmetadata-onlyにでき、不成立時は現行source経路へfallbackできる。** A（常に可能）でもC（常にFull pixels必須）でもない。現行`pipeline::plan()`を画素なしでそのまま呼ぶ案ではなく、**Region Planが使用するframe・寸法・descriptorだけを既存geometry処理から作る案**である。今回、実装・Native patch・contract・policy・budget・scheduler・transport・StageCacheは変更していない。

画素依存の主な障害は、未解決のauto uprightと自動lateral CAである。Photoの幅・高さだけを信じる、Wholeのaspect/丸め済みNative寸法からFull寸法を逆算する、クライアントのgeometryIdをそのまま返す、空のダミー画像で`pipeline::plan()`を呼ぶ、という案は採用できない。

また、C3-Bの659.82msはFull sourceを準備する費用である。Planから取り除いても、現在のRegion renderは同じsourceを必要とする。**初回Region renderへ費用が移り、最初のRegion画像までの総待ち時間が同量短くなるとは限らない。** Planだけが必要な場面では生成そのものを回避できるが、すぐrenderする場合の効果は主にpreflight応答の早期化となる。

## 2. 調査基準・コードの所在

作業開始時HEADはC3-Bの`ef25f6b`。対象はLightCraft v0.14.0 / upstream `03c88c166c054c009db2a47187d59991f6232b85`と現行[managed patch](../../../native/lightcraft/patches/0002-v0.14-native-contracts.patch)。以下のNativeパスはこの組合せのsourceを指す。検証に使用したcheckoutは`.tmp/lightcraft-0.14`であり、成果物としてそのcheckoutを変更・コミットしない。

| コード | 確認した境界 |
|---|---|
| `crates/mcp/src/region.rs::execute_inner` | Planのjob/source選択、二段階fit、geometryId照合、response、Full source保持 |
| `crates/engine/src/media.rs::DecodedSource::{image_for,info_or}` | denoise画像選択、decoder metadata優先 |
| 同 `source_edge_needed`, `build_job`, `source_ref_plain` | cropを含むsource level選択、Full/Preview区別、proxy/fallback |
| `crates/pipeline/src/lib.rs::{plan,frame_for}` | upright、auto CA、frame.fit、red eye等 |
| `crates/pipeline/src/geometry.rs::Frame` | orientation/crop/flip/lens/perspective/constrain、Native寸法、fit |
| `crates/mcp/src/preview.rs::frame_metadata` | canonical descriptor contract 2、SHA-256、丸め、検証 |
| `crates/pipeline/src/{upright,optics,profiles,redeye}.rs` | 内容解析、fingerprint、profileの実効settings、非geometryの画素使用 |
| `crates/engine/src/files.rs::{probe_bytes,load_bytes_now}`, `crates/raw/src/lib.rs` | probe寸法とFull decode寸法の関係 |
| `frontend/src/rawRegion.schema.json`, `backend/raw_region.py` | frame responseとdiagnosticsのvalidation |

## 3. load_source後のデータ依存

| 現行処理 | 実際の依存 | Region Planに必要な部分 |
|---|---|---|
| `decoded.image_for(amount)` | amount 0/1はplain/twin Arc選択、中間値は画素mix・memoization。twin寸法不一致等はplainへ戻る | frameに必要なのは選択画像の実際の幅・高さ。画素値はupright/CA等を有効にした場合に間接的に必要 |
| `decoded.info_or(job.info)` | decoder infoを優先し、native_longをheaderから補完。decoder infoなしならheaderにcamera_toneを補完 | frameに直接必要なのは実効lens metadata。Photo/headerが常にdecoderの全infoと同値とは言えない |
| `profiles::effective()` | settingsの色・tone等の変換。現行profile実装はcrop/orientation/optics/geometryを変更しない | metadataだけで実行可能。同じ関数を使い、別のprofile解釈を作らない |
| `upright::resolve()` | geometry section有効、Off/Guided以外、かつ保存transformなしの場合は画像解析 | この条件ではpixels必須。解決済みtransform、Off、Guided、section無効は解析不要 |
| `frame_for()` | 実画像寸法、settings、info.lens。optics有効かつremove_caなら画素解析でCAをframeに加算 | metadata-only最大のもう一つの例外。remove_caは単なる固定係数ではない |
| `Frame::native_size_at(original)` | original grid、ユーザーorientation、解決後crop、viewなし | 画素参照なし。fractional寸法を得てからresponse用にroundする |
| `frame_metadata()` | frame、original、source key、出力幅・高さ | 画素参照なし。ただしframeが正しく解決済みであることが前提 |

`pipeline::plan()`にはさらに次の画素使用があるが、すべてがPlan responseのgeometryに必要なわけではない。

- `redeye::resolve()`は目の領域のpixelsを読む。ただし結果は`Plan.eyes`とstage keyへ入り、frame/w/hを変更しない。frame-only helperなら計算を省ける。既存plannerをそのまま呼ぶならred eyeありを画素不要とは言えない。
- spot source自動選択は`req.window.is_some()`の場合。Region **preflight**のjobはwindowなしなのでこの分岐を通らない。
- dehazeのfixed airlight計算もwindowありの場合。Region preflightでは通らない。
- WB、detail scale、stage key、mattes等はrender計画用。今回のPlan responseには返さず、geometry-only helperが完全な`pipeline::Plan`を偽造する必要はない。

## 4. 各設定とgeometryの関係

| 条件 | 画素依存・再利用上の注意 |
|---|---|
| EXIF orientation | RAW probeの`developed_size()`をEXIFに従ってswapしPhoto寸法へ保存。Full loaderも最後にEXIF orientationを適用する。Photoは既にEXIF-orientedであり、再度EXIF回転すると二重適用になる |
| ユーザーorientation | `Frame::with_lens`がPhoto/decoded寸法に追加適用。metadata-onlyで処理でき、descriptorの一部 |
| crop / straighten angle / flip | normalized cropとangle、flipはsettings由来。angleは座標変換・IDに影響するが、`rect_px()`の幅・高さ自体を回転bounding boxへ置き換えてはいけない。overscanや1px未満のcropも既存計算に従う |
| lens / manual geometry | 固定lens係数、manual transform、保存upright transform、Guidedのguideは原理的にmetadata-only。ただしlensはdecoder/headerの同値性、reorientation、元寸法が必要。Guidedも画素解析はしないが、aspectに依存するsolverなのでPreviewの解を無条件に流用しない |
| constrain_crop | warped image境界へcropを縮める処理。pixelsは読まないが、source aspect・warp・浮動小数点計算に依存する。Previewの解決済みcropがFullでもbit単位に同じとは一般化しない |
| 未解決auto upright | `analyze_source`がlens補正済み画像を1024辺でsampleし、輝度・segment・vanishing pointを推定。FullとPreviewのpixels/寸法は異なる。既存解析cacheのkeyにも寸法と512画素のfingerprintが入る。Previewで解析済みでもFullの同値性の証拠にはならない |
| 自動CA除去 | `estimate_lateral_ca()`は寸法・512画素のfingerprintをkeyに推定値を保持し、frame.warp.caを変更する。geometryIdにも反映される。StageCacheとは別のcacheであり、そのhitにもpixelsが必要 |
| profile / camera metadata | profile lookやSDR renditionは現行実装では色/tone変更。camera colour、WB、camera tone、mattes等も直接frame寸法を変えない。ただしinfo.lensはgeometry入力。画像内容解析が有効ならsource生成時の色変換やdenoiseも解析結果へ間接的に影響する |
| denoise | plain/twinは通常同寸法でgeometryは同じ。しかしmixはpixelsを作り、File loaderはdenoise product生成を実行・失敗し得る。最初のfast pathでは実効denoise amount > 0をfallbackし、副作用・失敗時点を安易に省かない |
| Draft / Full | `RenderJob::draft()`はquality/keyを変える。preflightのframe処理自体にはquality分岐がない。最初の案はFullのみを対象とし、Draftは既存経路を維持してもよい |

## 5. Full width/height・rounding・geometryIdの同値性

現行preflightは単にNative width/heightを返していない。次の順序を維持する必要がある。

1. `size = ceil(desiredLongEdge).max(1)`。`render_job(size,size,...)`で既存source levelとsettingsを選ぶ。**cropによってsource必要辺長が増える**ので、desiredLongEdgeだけでFull/Previewを判断しない。
2. 実効settingsと実source寸法からframeを作り、`frame.fit(size,size)`で仮Full寸法を得る。
3. 同じframeの`native_size_at(Photo.width,Photo.height)`からfractional Native寸法を得て、`round().max(1)`したnw/nhを作る。65536制限も維持。
4. 仮Fullがnw/nhを超えた場合、requestのmax_w/max_hをそれぞれnw/nhへminし、再plan/fitする。overscanを含むこの再計算を、単純な辺長clampへ置き換えない。
5. `frame_metadata()`の正数・finite・viewなし・fit整合等を検証し、要求geometryIdと照合、Full <= Nativeを確認して返す。

`Frame::fit`はaspectを使い、±0.5pxの「既にaspectに合うbox」判定を先に行い、その後roundする。`Frame::aspect()`は各crop辺を最低1pxとして扱う。**fractional Native幅/高さの比、整数化後のNative幅/高さの比、Preview sampling aspectは同じ情報ではない。** Full helperは既存`Frame::fit`を呼び、JS側へ丸め規則を複製しない。

descriptor contract 2のgeometryIdは、contract、source key、original寸法、fractional Native aspect、orientation、解決済みcrop、flip、座標を動かすwarpをJSON化したSHA-256。出力bitmap寸法、quality、toneは含まれない。gain-onlyのvignetteは識別から除外する。frame内部のsampling dimensions / stage cache用`geo` hashは別物である。

したがって、以下を満たせば既存のresponseと同値にできる。

- Full sourceが実際に持つEXIF-oriented寸法をmetadataから確定できる。
- 実効settingsおよびframeに寄与するsource metadataが現行経路と同じである。
- 画素解析で追加されるframe変更が存在しない。
- 同じ`Frame::with_lens`、`native_size_at`、`fit`、`frame_metadata`を同じ順序・入力で使う。

この場合、`pipeline::plan()`の残りの計算は使用するframe/w/hを変更しないため、Full RGB pixelsを作る必要がない。

## 6. Whole情報を再利用できる範囲

Whole responseはgeometryId、丸め済みNative幅/高さ、sampling由来aspect、Whole bitmap幅/高さを持つ。しかし**canonical descriptor本体やfractional Native寸法、解決済みupright/CA、完全なframeは公開していない**。Headlessはrendered frameからmetadataを作るが、現在それをmetadata-only Plan用のcanonical frameとして保存していない。StagePoolのgeometryId保持をframe保持と同一視しない。

再利用できるのは、同一source/document/After revisionまたはBefore identityのgeometryIdを**検証期待値**にすること、およびNative幅/高さを結果の照合に使うこと。opaque hashからcrop/warpを復元することはできない。Before/Afterは別settings ownerで、geometryが一致する場合でもidentityを混同してはならない。

WholeのbitmapsからFull寸法を拡大推定することも不可。既存canonical testは4064×3056と丸められた2560×1925が同じgeometryIdを持てることを確認しているが、sampling aspectは異なる。具体例として、normalized crop幅0.316・高さ0.7、desiredLongEdge 1500では、Native gridでのfitは900×1500、Preview sampling aspectでのfitは901×1500となる（`Frame::fit`式による数値確認）。このcropでは既存`source_edge_needed`は2849となりFullを選び、Native上限1284×2139内なので再clampによって差が消える例でもない。**同じgeometryIdでも任意のdesiredLongEdgeのFull寸法がPreview aspectから再現できるわけではない。**

将来、Nativeが既に検証済みのFull-compatible canonical frameを保持するなら再利用は可能だが、新しいstate/invalidation設計を要する別案となる。今回の最小案はそのようなcacheを追加せず、Photo/settings/source headerから必要なframeを再構成する。

## 7. 最初のfast pathのfail-closed条件（提案）

すべてを満たした場合だけ採用する。より広いmanual lens/geometry対応は原理的には可能だが、初回実装に含める必然性はない。

1. `operation=plan`、windowなし、既存target validation成功、同一document/source owner、現行jobのAfterまたはBefore settingsを使用。初版はquality Fullだけ。source選択は現行`render_job`を維持し、**選択levelがFull**のケースだけを対象とする。Preview/ThumbをFull gridへ読み替えない。
2. sourceはsupported native RAWの通常File経路。最初はDNGに限定し、preview_only、Smart/offline/proxy、reduced source、custom loader、denoise product生成等は対象外。既にFull loadedなら安い既存経路を使えばよい。
3. Full decoded寸法を**metadataの出所も含めて証明**する。DNG headerの`probe_info`とFull decodeは同じdecoderのHeader/Full modeを使う。通常経路はactive area → default crop → pixel-aspect stretch → EXIF orientationの順であり、`Photo`はこのprobe結果を保持する。Full develop側の`normalized` → `finish_demosaiced` → orientationと同じ寸法になるものに限る。
4. ただしPhoto寸法一致だけでは十分でない。`RawInfo::developed_size`はcrop幅・高さが両方 > 1の場合に採用する一方、`develop_crop`は0でなければ採用するという境界差がある。**clipped cropが両辺 > 1、active areaが有効、finite/positiveなpixel aspect、両経路の計算結果がPhoto寸法と一致**することを確認する。未知のdecoder経路・opcode挙動・header/full差はfallback。現行opcode処理は画像寸法を保持し、TrimBoundsは適用しないが、将来の実装差を暗黙に許可しない。
5. そのprovenanceは現在のPhotoの幅/高さだけからは復元できない。既存metadataで確定できない場合は既存RAW header probeを使って確認するか、fallbackする。**RAW probeのためのfile read/header解析はmetadata-onlyに含まれるが、その費用は未測定**。現行`probe_info`はbytes入力なので、無償のheader取得を仮定しない。新しいpixel/cache設計は不要。
6. `profiles::effective()`後のsettingsで、未解決auto uprightがない（geometry section無効、Off/Guided、または保存transformあり）。さらに**optics section無効、またはremove_ca=falseかつlens_profile=false**。初版はFull gridのframeを構成した結果、`warp.moves_pixels()`がfalseであることも要求する。これによりmanual distortion/CA/perspective、Guided/保存transformによる非identity warp、lens起因constrainの同値性を初版の受入対象から外す。gain-only vignette、通常のcrop/straighten/flip/ユーザーorientationは許容できる。
7. 実効denoise amountは0。header/decoderのlens不一致はlens_profileを無効化した範囲ではframeへ寄与しない。WB/camera tone等を架空の`SourceInfo`で補って完全なPlanを生成しない。
8. 既存Full source予約budget検査を維持し、既存と同じframe fit、Native cap/re-fit、metadata検証、source keyとgeometryId照合を行う。求めたgeometryIdが期待値と異なる、値が非finite、寸法上限や検証条件を満たさない場合、**新しい値を成功として返さず現行source経路へ一度だけfallback**。その経路も不一致なら既存のgeometry mismatch等を返す。

これは十分条件の提案であり、全metadata-only可能ケースの必要条件ではない。C3-Bの標準設定はsettings条件に入り得るが、今回DNG header provenanceの新しい実装や実RAW fast-path比較は行っていないため、そのRAWがこの全guardを通過したとは報告しない。

## 8. 最小実装案とcontract

将来の実装はNative内で次の範囲に限定できる。

1. `pipeline::plan`からframeの構成部分を共有できるようにし、**寸法＋実効settings＋必要なlens metadataでframeだけを作るhelper**を用意する。`Rgb32f::new(native_w,native_h)`の確保や偽pixelsは不要。auto upright/CAが必要な呼出しは既存画素経路のままにする。
2. `region::execute_inner`のload直前でguardを試し、成立時だけframe-only結果を使う。既存のfit/cap/re-fit/descriptor/echo/Before fingerprintの処理は共通化し、片側だけに丸めや識別規則を複製しない。
3. fast pathではdecoded sourceが存在しないため、`accept_preview_source()`を呼ばず、source保持・WB discovery・History更新が起きたふりをしない。renderは現行load経路を使う。
4. diagnosticsはsource未生成を正直に示す。例えば`planTiming.sourceKind`へ`metadata`を追加し、`sourceHostBytes=0`、`sourceCacheBytes`は実保持量、sourceLevelは選択levelとして扱う。Backend/Frontendのallowlist・型・validationを同時更新する。未生成bufferのcapacityを推測して報告しない。

**公開Region frame request/responseの変更は不要**。operation/quality/geometryId/identity/revision/requestId/desiredLongEdge/Native/Full寸法/kindは現行契約のままにでき、contract versionや永続形式の変更も不要。必要になる可能性があるのは上記diagnostics vocabularyの拡張とNative内部helperだけである。requestへ新たにcanonical frameを送らせる案は最小案ではない。

なお、schemaが同じでも挙動は完全に無変更ではない。Full decodeの破損・I/O・denoise等の失敗がPlanでは判明せず初回renderへ遅れる可能性、Plan後のsource cache/memory保持量が減ることを説明・検証する必要がある。Plan契約に「Full decode成功済み」を新たに仮定せず、rendererの既存検証・fallbackを残す。

## 9. 効果・リスク・実装時に必要な最小確認

- 成立するcold PlanではC3-BのFull source生成659.82msをその呼出しから除ける。残るmetadata read、frame生成、validation、MCP費用は存在し、**実装前に0.254msや特定の改善後totalを保証できない**。
- 初回renderはsource生成を引き受けるので遅くなる見込み。Plan→render全体では主に待ち場所の移動であり、Full source生成自体の最適化ではない。全体の体感改善を目的にするなら、その意味を先に判断する価値がある。
- auto CA/未解決uprightでPreview解析結果を流用すると、Fullとgeometryが異なるおそれがある。constrainとlensもaspect/provenance未確認ならfallback。
- rounded Native幅/高さだけでframeを作るとfractional crop/overscan/fit境界を壊す。hash一致だけでもFullサイズを保証しない。
- 同一document内でもsource変更、Before切替、settings変更、owner変更は再判定。今回の案では新しいframe cache/invalidation状態を持たない。
- 実装時はguard通過するorientation/crop/flip/細いcrop/overscan/丸め境界、Before/After、任意desiredLongEdgeの新旧Plan response比較と、guard不成立のupright/CA/lens/denoise/proxy/header異常fallbackをfocused testにする。first renderのcold cost移動とdecode失敗の遅延も確認する。これは**次の実装時の項目**で、今回は新しい試験群を追加しない。

## 10. 今回の確認結果

- `load_source`以降のframe/w/hへの依存、RAW寸法provenance、descriptorとfitの規則、Whole/Region caller、schema/validationを静的確認。
- Native既存focused test: `cargo test --locked -p lightcraft-mcp canonical_ -- --test-threads=1`、**4 passed**。sampling aspectとNative aspectの分離、toneとgeometryの識別、sampling cache分離、Whole/source level/quality/BeforeとRegion Full寸法の既存整合を確認した。新fast pathの正しさを試験したという意味ではない。
- 上記1px差の例は既存`Frame::fit`と`source_edge_needed`式を転記した小さな数値確認。新Native fast pathの実行試験ではない。
- `git diff --check`実施。調査文書のみの変更なのでBackend/Frontend suite、型チェック、production build、Native再build、performance benchmark、Computer Use、browser/NAS確認は追加実施しない。README/CHANGELOGの変更は不要。
