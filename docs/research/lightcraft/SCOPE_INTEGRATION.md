# Windows版スコープ統合調査（P0）

調査日：2026-11-28（Asia/Tokyo）。GenzoRoom `main`、調査基準HEAD `340ce55a5778704c5fed9166b5f3bd87817962ae`。この文書はP0事前調査を記録する。P1／P2の実装結果、仕様確定、監査結果は後続節へ追記し、当時の調査結論と区別する。

## 証拠区分

| 区分 | 意味 |
|---|---|
| **確認済みの事実** | 指定commit、ローカル作業ツリー、既存テスト、managed patchから読める実装・契約。ソースの記載は実行確認を意味しない。 |
| **ソースからの推論** | 複数の実装境界から導く接続可能性、互換性、性能・複雑性の判断。実測値とは区別する。 |
| **実装提案** | P1／P2の候補。後続実装で決定・変更できる。 |
| **未確定・未確認** | 追加設計、ソース実行、実機確認が必要な事項。 |

このP0ではソース、patch、manifest、既存receiptの読み取りとcommit状態の確認を行った。製品コード、patch、manifest、バイナリ、既存プロジェクト文書は変更していない。テスト、ビルド、Native起動、GUI／ブラウザ操作、性能実測は行っていない。

## 1. 調査対象とソース状態

| 対象 | 調査基準 | 確認内容 |
|---|---|---|
| GenzoRoom | `main` / `340ce55a5778704c5fed9166b5f3bd87817962ae` | 開始・終了時の作業ツリーはclean。取得・更新・resetは行っていない。 |
| LightCraft upstream | `v0.20.0` / `192ff72923c39e6623f2c7ff67ab3a119deb8071` | 固定版のGit objectをソース根拠とした。現在の隣接checkout HEADは別commitのため、その状態を上流ソースとして混同していない。 |
| GenzoRoom managed patch | `native/lightcraft/patches/0001-v0.20.0-whole-frame.patch` | manifestに登録されたactive patchは1本。実SHA-256 `a72ebfa66ce04b3aea5232b8d5a665ab8a4e0a1e2e169a8deb6286639778f974`、18 targets、追加1,342行・削除38行がmanifestと整合。 |
| LightCraft artifact | 既存ローカルreceipt 2件 | 対応するEXE SHA-256はいずれもreceiptの`2e04fea8da7d84018baf7384043656af482a23986a1c63361f8200923e77eef7`と整合。実起動は行っていない。 |
| ChromaForge | `fd826150273fd0147389038fe69433e03a1e6978` | GitHub公開HEADを取得し、ソースファイルと導入commit履歴を固定SHAで参照した。 |

GenzoRoomのmanifestはupstream commit、LightCraft version、patch targets／digest、Previewを含む各Native契約versionの正本である。P0ではLightCraft更新も成果物再生成も行っていない。

## 2. GenzoRoom現行実装

### 2.1 JPEG Histogramの集計・表示

**確認済みの事実。** `AdjustedImage`はデコード済みRGBA8からBeforeを集計する。AfterはGPU描画出力、CPU Worker出力、または主スレッドCPU経路から集計し、描画に採用した結果と同じsource／Recipeを識別して通知する。Workerも同じ`collectHistogram`を呼ぶ。`collectHistogram`は全画素をR/G/B/Y′の各256 binに数える。Y′はsRGB値に対して丸めた係数`0.2126, 0.7152, 0.0722`を使う。

`AnshitsuPage`はAsset IDと画像source keyが現在のものに合う通知だけを採用し、Asset／source切替時に以前の集計を消す。`ScopePanel`はチャンネル表示、Y Only、Normal／Expandedを持ち、`HistogramGraph`は256binのSVGを描画する。ExpandedではP99を用いる。Scopeセレクターは現状Histogramだけである。

| 対象 | リポジトリ相対参照 |
|---|---|
| Histogram計算とデータ型 | [`frontend/src/histogram.ts`](../../../frontend/src/histogram.ts)、[`frontend/src/AdjustedImage.tsx`](../../../frontend/src/AdjustedImage.tsx)、[`frontend/src/adjustmentWorkerRuntime.ts`](../../../frontend/src/adjustmentWorkerRuntime.ts) |
| Scope UI／描画 | [`frontend/src/ScopePanel.tsx`](../../../frontend/src/ScopePanel.tsx)、[`frontend/src/HistogramGraph.tsx`](../../../frontend/src/HistogramGraph.tsx) |
| Asset/source所有とJPEG／Native分岐 | [`frontend/src/AnshitsuPage.tsx`](../../../frontend/src/AnshitsuPage.tsx)、[`frontend/src/ImageViewer.tsx`](../../../frontend/src/ImageViewer.tsx) |
| Scope高さ・ハンドル | [`frontend/src/scopeSizing.ts`](../../../frontend/src/scopeSizing.ts)、[`frontend/src/ScopeResizeHandle.tsx`](../../../frontend/src/ScopeResizeHandle.tsx)、[`frontend/src/style.css`](../../../frontend/src/style.css) |

### 2.2 Windows Native Previewと表示同期

**確認済みの事実。** `AnshitsuPage`はLightCraft利用時に`useRawDocument`のNative PNGをViewerへ渡す。`editable`はJPEG編集機能用の状態である。現状ScopePanelの`keyboardBlocked`にも`!editable`が使われるため、NativeでJPEG版Scope操作を有効にするには、ワークスペース全体のdialog／save／switch等のガードを保ちつつ、Native文書の可用状態に基づく判定へ変更する必要がある。

Native PreviewのHTTP応答はPNGとrevision、generation、token、serial、kind、quality、Frame等を持つ。Frontendは要求・文書所有権を検査してPNGをデコードし、遅着・古い世代・古いrevisionを破棄する。Beforeは独立要求系列で管理し、Before key、品質、サイズ等に結び付く。実効Before表示は永続Before/After状態とBackslash長押しを合わせてViewerが決める。Pan／ZoomはWhole要求サイズに影響する。Region表示はWholeを背景とし、必要なBefore/AfterのRegion bitmapを重ねる。

| 境界 | リポジトリ相対参照 |
|---|---|
| Native PNGと応答ヘッダー | [`backend/windows_raw_api.py`](../../../backend/windows_raw_api.py)、[`backend/lightcraft_raw.py`](../../../backend/lightcraft_raw.py) |
| MCP Preview要求と上限 | [`backend/lightcraft_runtime.py`](../../../backend/lightcraft_runtime.py)、[`backend/lightcraft_mcp.py`](../../../backend/lightcraft_mcp.py) |
| Frontend Preview検証 | [`frontend/src/rawApi.ts`](../../../frontend/src/rawApi.ts) |
| Whole／Before／Draft／Full lifecycle | [`frontend/src/useRawDocument.ts`](../../../frontend/src/useRawDocument.ts)、[`frontend/src/rawWholePreview.ts`](../../../frontend/src/rawWholePreview.ts) |
| Whole／Region画像所有 | [`frontend/src/rawRegionOverlay.ts`](../../../frontend/src/rawRegionOverlay.ts)、[`frontend/src/rawRegionDelivery.ts`](../../../frontend/src/rawRegionDelivery.ts) |
| ViewerのBefore／AfterとRegion合成 | [`frontend/src/ImageViewer.tsx`](../../../frontend/src/ImageViewer.tsx) |

### 2.3 リサイズ、キー、既存回帰テスト

Scope領域は暗室右パネル内で高さ15〜40%、初期30%の範囲で変更できる。値は`localStorage`へ保存する。ヘッダーにある既存selectを4種類のモードに拡張する案は追加確定仕様と一致する。

アプリケーションのキー割当は`frontend/src/editShortcuts.ts`の`shortcutBindings`に集約される。Histogramはテンキー1／2／3でRGB、テンキー0でY Only、テンキーDecimalで縦軸切替を行う。コンポーネントは`matchesShortcut()`を用い、defaultPrevented、IME、修飾キー、編集対象、dialog/menu、keyboardBlockedを確認する。`shortcutDisplay.ts`の`formatShortcut()`が表示用ラベルを組み立てる。Windows DesktopのNative menu handlerは主に設定・編集コピー／ペーストのイベントをWebViewへ中継し、Scope専用のNativeキー配送はない。

関連テストは以下に存在する。今回のP0では実行していない。

| 確認対象 | 既存テスト |
|---|---|
| Scope UI、既定表示、Y Only、軸表示 | [`frontend/src/ScopePanel.test.tsx`](../../../frontend/src/ScopePanel.test.tsx) |
| Histogram集計 | [`frontend/src/histogram.test.ts`](../../../frontend/src/histogram.test.ts) |
| JPEG集計とViewer表示同期 | [`frontend/src/AdjustedImage.test.tsx`](../../../frontend/src/AdjustedImage.test.tsx)、[`frontend/src/ImageViewer.test.tsx`](../../../frontend/src/ImageViewer.test.tsx)、[`frontend/src/AnshitsuPage.test.tsx`](../../../frontend/src/AnshitsuPage.test.tsx) |
| リサイズ・保存 | [`frontend/src/ScopeResizeHandle.test.tsx`](../../../frontend/src/ScopeResizeHandle.test.tsx)、[`frontend/src/scopeSizing.test.ts`](../../../frontend/src/scopeSizing.test.ts) |
| ショートカット・ヒント | [`frontend/src/editShortcuts.test.ts`](../../../frontend/src/editShortcuts.test.ts)、[`frontend/src/shortcutDisplay.test.ts`](../../../frontend/src/shortcutDisplay.test.ts)、[`frontend/src/shortcutHints.test.tsx`](../../../frontend/src/shortcutHints.test.tsx) |
| Native Draft／Full／Before／Asset switching | [`frontend/src/AnshitsuRawPreview.test.tsx`](../../../frontend/src/AnshitsuRawPreview.test.tsx)、[`frontend/src/rawApi.test.ts`](../../../frontend/src/rawApi.test.ts) |
| Backend Preview・MCP envelope | [`backend/tests/test_raw_adaptive_preview.py`](../../../backend/tests/test_raw_adaptive_preview.py)、[`backend/tests/test_lightcraft_mcp.py`](../../../backend/tests/test_lightcraft_mcp.py) |

## 3. LightCraft固定版の演算とNative API

### 3.1 既存Histogram

**確認済みの事実。** 固定upstreamのRaster `Histogram`はR/G/B/Lumaそれぞれ256 binの`Vec<u32>`とtotalを持つ。`Histogram::of_srgb8`は表示符号化RGBA8を規則格子で最大約100万サンプルまで間引く。CPU Pipelineの通常SDR renderとGPU renderの双方に既存Histogramがある。GPUの`wgsl/hist.wgsl`は出力RGBA8から同じ整数式でRGB・Luma binを作り、結果をGPU bufferで返す。CPU/GPU選択、fallback、画像データ、cacheはLightCraftが所有する。

RAW／非RAWともHeadless `render_preview`から`Session::render_job`を通り、現像済みの`Rendered`が生成される。managed patchの`ui.render`はBefore設定、Draft／Full、Whole／Crop Edit等を同じNative処理境界へ渡す。通常のSDRでBefore／After、Draft／Fullすべてに既存Histogramが付く構造である。

### 3.2 APIに含まれないデータ、HDR、診断表示

**確認済みの事実。** 現行MCP `render_preview` 応答には画像とmetadataがあるが、既存Histogram binsは返さない。managed patchで`Rendered.histogram`を生成した後にAPIへ追加することで、追加現像を要求せず転送できる。Region Native APIも現在はFrame／geometry等のRegion契約で、Scope集計を公開していない。

LightCraftのSDR Lumaは`(54R + 183G + 19B) >> 8`で、JPEG版Y′の係数・丸め方とは異なる。またLightCraft側は約100万サンプルへ間引く一方、JPEG版は画素全数を使う。これは表示サンプル定義の差であり、同じ画像でbin数の一致を要求できない。

HDR設定のFullでは`develop_reporting`がSDR renderのHistogramをHDR用小型renderのHistogramで置換する場合がある。HDR binsは同じ256 binでも意味・値域がSDR histogramと異なり、既存Graphの0〜255表示に直接流用できない。Draftでは別HDR計算を行わない。Display Profileや一部診断Overlayでは写真のHistogramがOverlay適用前の結果として保たれる。P1でどの集計段階を公開するかをAPI契約に固定する必要がある。

固定版LightCraft本体のRaster／Pipeline／GPU／MCP／Desktop UIに、今回対象とするWaveform、RGB Parade、Vectorscope計算・表示は見つからなかった。Desktop HistogramはRenderer内のPreview Histogramを再利用し、必要時はThumbnailへフォールバックする。P0でDesktop内部の画素結果やUIをGenzoRoomへ接続する経路は確認していない。

| 固定ソース | 範囲 |
|---|---|
| [Raster Histogram](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/raster/src/histogram.rs) | `Histogram`構造、`of_srgb8`、flat words変換 |
| [CPU Pipeline](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/pipeline/src/lib.rs) | `Rendered.histogram`とrender終段 |
| [Engine render](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/media/render.rs) | `develop_reporting`、CPU／GPU選択、HDR histogramの置換 |
| [GPU render](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/gpu/src/render.rs)、[WGSL histogram](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/gpu/src/wgsl/hist.wgsl) | GPU出力の集計・bins読み戻し |
| [Headless session](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/media/session.rs)、[MCP tool](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/mcp/src/tools.rs) | `render_job`と`render_preview` API境界 |
| [Desktop Histogram](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/ui-egui/src/panels/edit/histogram.rs)、[Desktop renderer](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/ui-egui/src/render.rs) | Preview HistogramをUIへ渡す箇所 |

## 4. ChromaForge実装、差分、ライセンス

### 4.1 対象ソースと処理形式

調査対象はChromaForge commit `fd826150273fd0147389038fe69433e03a1e6978`。このcommitは公開repositoryの調査時HEADである。UIはRust egui、集計はRust Raster、GPU集計はWGSL/wgpu。

| 機能 | 入力・集計／データ形式 | 描画・主要関数 |
|---|---|---|
| Histogram | display-encoded RGBA8。RGB／Luma／Chromaは各256 binの`u32`、最大約1M点を規則格子でsample。Coverage maskは任意。 | `Histogram::of_srgb8_covered`。egui側`paint_plot`／`paint_plot_compact`でsoft bins・curve・fillを描画。Linear／Logarithmic scaleとrobust peak。 |
| Waveform | 同じRGBA8のsample位置とR/G/B値。128列×64段、RGB各planeを`u16` countで保持。列別sample数を補正。 | `waveform_tracks`は3 planeの重畳。`waveform_image`は98 percentileでdensityを正規化、加算色の小画像を作成しtexture化。 |
| RGB Parade | Waveformと同一のRGB plane・counts。新たな画素走査を必要としないデータ形状。 | `waveform_tracks`がplot幅を3区画に分け、各々R/G/B planeを表示。 |
| Vectorscope | RGBA8のRGBからinteger Cb/Cr座標。65×65 grid、`u32` count。Neutralは中央cell。 | `scope_cell`／`scope_uv`で座標。`paint_vectorscope`が非ゼロセルの98 percentile密度、リング、軸、彩度targets、123° skin-tone lineを描く。 |

Waveformの集計は各列でサンプルされたpixelのLuma/R/G/Bを階調64段へ加算する実装で、vectorscopeはCb/Crの固定係数でcellを求める。CPU実装がRaster側の基準になる。GPU `hist_k`はRGB/Luma/Chromaの1D binsに加えてscope gridと4-plane Waveformをbufferに保持する。UI／mode選択は`crates/ui-egui/src/panels/edit.rs`、描画は`crates/ui-egui/src/panels/histogram.rs`。Scaleは`crates/raster/src/histogram.rs::HistogramScale::height`でcountを線形またはlogarithmicに正規化する。

添付画像2の左右矢印UIは参考画像として扱う。調査commitの実装ではEdit panelの`histogram_display_menu`がmode／scaleを選ぶ。今回確定済み仕様はGenzoRoom既存プルダウンの再利用であり、矢印UIは移植対象外である。

| Source | 主な根拠 |
|---|---|
| [Raster histogram／scopes](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/crates/raster/src/histogram.rs) | `of_srgb8_covered`、`bump_wave`、`scope_cell`、`scope_uv`、`Histogram` data |
| [egui scope rendering](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/crates/ui-egui/src/panels/histogram.rs) | `paint_vectorscope`、`waveform_tracks`、`waveform_image`、histogram plots |
| [mode／scale menu](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/crates/ui-egui/src/panels/edit.rs) | display menu、preview histogramと専用512px panel render |
| [GPU shader](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/crates/gpu/src/wgsl/hist.wgsl)、[buffer assembly](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/crates/gpu/src/render.rs) | `hist_k`、Waveform／Vectorscope buffer layout |
| [Mode regression tests](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/crates/ui-egui/src/tests_histogram_modes.rs) | mode別描画、scale、waveform、paradeの確認 |

### 4.2 LightCraftとの共通性とコードの由来

**確認済みの事実。** ChromaForgeはLightCraftのforkで、表示符号化RGBA8、256-bin RGB/luma Histogram、規則格子sampling等の共通構造を持つ。スコープ機能はChromaForge側の開発commitに現れる。Vectorscopeの導入commitは`222b60a878a5030947aa40d15ede3ac80041494c`、Waveform／RGB Paradeは`273ae566f15545d124dbc4e7eff82c1d51550016`、GPU集計追加は`765720742c4c76384c4c0eb367bf89d807550009`。

現行ChromaForgeはRasterにCoverage mask・Chroma追加、GPU bufferにscope/wave各plane、eguiに表示機能を含む。GenzoRoomが使うLightCraft v0.20.0にはこれらのスコープ計算は存在しない。構造を参考に小規模演算を選択的に実装できる。Rust egui、Catalog／develop pipeline、一般UI、Cache／Renderer全体は取り込まない。

**ライセンス判断。** ChromaForgeの固定commitはMITまたはGPL-3.0-or-laterを掲げる。`NOTICE`はfork由来コード等を記録し、対象のRaster Histogram／scope、対象WGSL、scope描画部分に対する別条件の記載は確認できなかった。LightCraft v0.20.0は`MIT OR Apache-2.0`。GenzoRoomはAGPL-3.0-onlyで配布時にthird-party noticeを生成する。対象scope演算を使う場合、MIT許諾・著作権表示を保持し、コード由来とcommitをthird-party attributionへ記載する方針が適合する。これは対象ファイルとNOTICEを読んだP0判断であり、正式な法律意見ではない。第三者由来コード・LICENSE表示は実装対象を確定した時点で再確認する。

| 根拠 | リンク |
|---|---|
| ChromaForge LICENSE／NOTICE | [LICENSE](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/LICENSE)、[NOTICE](https://github.com/emmertex/chromaforge/blob/fd826150273fd0147389038fe69433e03a1e6978/NOTICE) |
| LightCraft license | [Cargo.toml](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/Cargo.toml) |
| GenzoRoom license／notice packaging | [`LICENSE`](../../../LICENSE)、[`desktop/packaging/collect_distribution_materials.py`](../../../desktop/packaging/collect_distribution_materials.py) |
| MIT条件 | [Open Source Initiative: MIT License](https://opensource.org/license/mit) |

## 5. 再利用性と機能別難易度

| Scope | P0見立て | 再利用／追加実装 |
|---|---|---|
| Histogram | 低 | Nativeの既存4×256 binsをPreview metadataで受け、JPEG版`ScopePanel`／`HistogramGraph`へ供給。UI、スケール操作、領域、リサイズを再利用。Luma定義とsampling表示は異なる。 |
| Waveform | 中 | ChromaForgeのRGB列×階調集計をWhole RGBA8から作り、密度を小画像へ描画。 |
| RGB Parade | Waveformと同時なら低〜中 | RGB平面をWaveformと共有し、描画を3列に分割。集計は共通化できる。 |
| Vectorscope | 中 | RGBA8上のCb/Cr変換、固定格子集計、Canvas上のdensity plot／rings／targets／skin lineを追加。 |

**ソースからの推論。** Histogram単独なら既存データがあり、他3種類用の抽象基盤は不要である。WaveformとParadeは同じ集計が必要なので一緒に実装する合理性がある。Vectorscopeの座標・描画は独立性が高い。P1で4種類すべてを完成させる必要はなく、段階実装が最小リスク・最小複雑性となる。

## 6. 推奨するNative／Backend／Frontend接続

### 6.1 Native／managed patch

**提案。** P1では既存`render_preview`応答に任意のHistogram metadataを追加する。Nativeで既に作られた`Rendered.histogram`を使い、初回契約はSDR RGB/Luma各256 countsとtotal/sample countとする。RGB値・サンプル数の範囲・field versionを定める。Wholeの追加現像は行わない。Before／AfterとDraft／Fullはそれぞれ対応する`render_job`結果と同期させる。

P1は4KBの固定長binsがあり、既存MCP metadata制限16KiB内で渡せる見込み。ただし既存metadata validationは許可キー集合を厳密に検査するため、Native schemaとBackend validatorを同時に拡張する必要がある。HDRではSDR binsの位置を確定し、既存GraphへHDR分布を誤表示しない。

P2の初期案はWholeの現像済みRGBA8からNative CPU側でRGB waveform planesとvectorscope gridを一度に集計する。LightCraftがGPU renderを選んだ後にPNG用readbackがあるため、Native側の追加画像renderは原則不要。GPUへ処理を追加するのはCPU追加走査の性能測定で必要性が示された場合とし、GenzoRoomはGPU backend／StageCache／memoryを独自管理しない。

### 6.2 Backend

**提案。** 既存`render_preview` MCP tool、Preview validator、`PreviewFrame`、Windows HTTP preview応答を延長する。P1の小さいbinsはbounded JSON metadataまたは既定の制限に収まるbinary headerが候補。P2は無圧縮密度データが既存MCP text metadata上限を超えるため、画像と集計を同じ応答に含めるbounded binary envelope／multipart等の候補設計が必要である。既存Preview画像とデータの所有ID・revision・generation・Before key・qualityを同じ応答に結び付ける。スコープだけの現像要求や別APIを作る理由は現状見つかっていない。

### 6.3 Frontend

**提案。** `RawFrame`に任意Scope dataを載せ、PNGと同じ候補・採用lifecycleで更新する。Asset切替、文書generation、revision、Before keyが変わった遅着値を破棄する。Before表示には対応するBefore binsを選択する。Whole imageが採用されるとscopeも同時に採用する。Region合成ではRegion tilesを再集計せず、表示中のWhole baseに属するscopeを使う。Zoom／Panで表示範囲が変わってもscopeはWhole imageに対応させる。

既存selectの選択肢をHistogram、Waveform、RGB Parade、Vectorscopeにする。JPEG版のHistogram controls、ショートカット、`ScopePanel`／Graph、header、scope sizingを再利用する。新しい3種類はCanvas 2Dのdensity imageと目盛り描画を候補とする。Scope選択は表示状態なのでRecipe／History／Undo・Redoに保存しない。

追加確定仕様に従いChromaForgeの矢印切替UIは実装対象外。Histogramの既存操作とキー割当は維持する。P2追加ショートカットの割当はこの調査では決定しない。既存テンキー割当との競合を避ける場合、候補は未使用の`Shift+H`だが、中央レジストリ、platform label、shortcut一覧、focus guardを含め別途確定する。

## 7. データ量と性能上の論点

以下は配列要素数からの概算で、性能計測値ではない。

| Data | 内部サイズ／preview 1枚 |
|---|---:|
| Histogram RGB+Luma 4×256×u32 | 4 KiB |
| Waveform/Parade共用 RGB 3×128×64×u16 | 48 KiB |
| Vectorscope 65×65×u32 | 約16.5 KiB |
| 3種類の全データ合計 | 約68.5 KiB（base64化で約91.4 KiB） |

P1は集計を再利用すれば計算増よりserialization、validation、frontend parsingが主となる。P2は最大約1M点sampleの追加走査、bin更新、転送・描画が加わる。既存NativeのWhole PNG上限17MiB、MCP Preview line上限24MiB、metadata text上限16KiBを考慮する。P2の配列をtext metadataへ直列化する方式は上限に収まらない。必要な格納・transportはスコープ応答に限って有界にする。メモリ保持は現行表示中Wholeと必要なBefore/Afterに限定する案であり、実際のframe lifetimeは実装で検証する。

すべての2D分布を毎回計算すると切替は即時だが、Histogramしか見ていない時もCPU集計する。選択中のみ集計すると処理を減らせる反面、切替時に同じrendered bitmapへアクセスでき、待ち時間中の表示と追加通信を適切に扱えることが条件となる。**提案**はP2初期試作でWaveform/Parade共通データとVectorscopeを一括集計し、Draft／Fullで実測してから最適化すること。Draft頻度とサンプル数はP0では決めない。

## 8. UI・ショートカットに関する提案

- Selectの初期値はHistogram。モード順はHistogram、Waveform、RGB Parade、Vectorscopeを提案。モード選択の永続化は今回は決定しない。選択状態をRecipe／Historyへ記録しない。
- HistogramはJPEG版の通常／拡大、R/G/B、Y Only、ヒストグラム表示、キー操作を保つ。Linux/macOS向けshortcut仕様も既存registryが担い、Windows WebViewでの物理テンキー動作を実機で確認する。
- WaveformはRGB重畳、RGB Paradeは3列表示、Vectorscopeは円形scope、Cb/Cr軸、skin-tone lineを候補とする。Linear／LogarithmicはChromaForgeの計数正規化を参考にできるが、P2で仕様決定する。
- Scope resize handleとpanel basisを再利用し、描画だけ既存Histogram Graphから分岐する。
- Histogramのショートカットは維持。Scope切替shortcutはP0で割り当てない。候補キーは追加時にcentral registryと一覧・フォーカス条件を一緒に確認する。

## 9. P1／P2実装候補ファイル

具体的な対象ファイルと分担は実装開始時に再確認する。下表は調査からの候補であり確定変更一覧ではない。

| 工程 | 主な候補 |
|---|---|
| P1 Histogram | Native patchの`crates/mcp/src/headless.rs`・`tools.rs`、`native/lightcraft/manifest.json`および既存build／receipt validation。Backend `lightcraft_runtime.py`、`lightcraft_raw.py`、`windows_raw_api.py`。Frontend `rawApi.ts`、`useRawDocument.ts`、`rawRegionOverlay.ts`、`AnshitsuPage.tsx`、`ScopePanel.tsx`。 |
| P2 Waveform／RGB Parade | P1のNative／Backend応答にbounded 2D dataを加える。NativeでRGB列・level bin生成。Frontendにscope mode選択とCanvas 2D／density画像描画を追加。既存scope領域とresize handleを使う。 |
| P2 Vectorscope | NativeにCb/Cr格子生成、同じ2D data transportを使う。FrontendにVectorscope renderingを追加する。Waveformと分割して実装可能。 |
| attribution | ChromaForge由来コードを採用する場合に、適用した断片の由来とMIT表示を配布third-party noticesへ追加。 |

README／CHANGELOG／architectureの更新はP0の作業対象ではない。機能完成後にユーザー向けREADME更新の必要性を判断する。

## 10. 必要最小限のテスト計画

P0では実施していない。実装時には変更境界に絞る。

1. Native managed patchのfixed HEAD適用、manifest digest／targets、schemaとreceipt、合成画像でのSDR Histogram。Draft／FullとBefore／Afterの応答tupleを確かめる。非RAWも同じPreview境界を通ることを確認する。
2. Backendのmetadata shape、bin数／数値型／上限、欠落フィールド、壊れた応答、stale revision、MCP Preview envelope sizeをfocused testする。
3. FrontendでNative histogram mapping、Preview採用と同時のscope更新、Before toggle／Backslash、Draft→Full、遅着・Asset switch・generation変更、Region base同期を確認する。JPEG Histogram・shortcuts・scope resize回帰を既存テストで確認する。
4. Frontend関連Vitest、TypeScript check、production build、`git diff --check`を実行する。Backend／Native変更があれば該当側のfocused test／buildも実行する。全suiteは影響範囲が必要性を示す場合に限る。
5. P2で合成gray・原色・横方向ランプを使い、Waveform列、Parade plane、Vectorscope中心と方向、density scale、Canvas小領域を検査する。追加render／通信なしで切替できるかテストする。

## 11. 未確定事項と実機確認

1. **HDR。** SDR Histogram binsをどのNative境界から取得し、HDR editでどの表示を維持するか決定が必要。既存0〜255 GraphへHDR Histogramを誤表示しない。
2. **Crop Edit。** Current Whole HistogramとCrop画像の表示領域が一致しない。P1はcrop edit中scopeを一時非表示とする案だが、確定していない。
3. **Diagnostic overlays／interaction previews。** シャープネスOverlay、Point Color Overlay、Curve／Mixer／Point Color draft previewそれぞれで、写真本体の分布を示すかoverlay結果を含む分布にするか決定が必要。現状診断Histogramはoverlay前の値を保つ境界がある。
4. **Region。** 初期仕様提案はWhole画像全体のscopeとし、Region tilesごとのscopeは集計しない。Region displayがWholeBefore／WholeAfterを採用した時に対応するscopeを保持できるか実装境界を確認する。
5. **Draft更新頻度。** すべてのDraftで2D集計するとCPU費用がある。性能計測前にthrottle／間引き頻度を確定しない。
6. **Native schema・transfer.** P1固定長HistogramはJSON metadataへの追加候補。P2密度配列は既存16KiB metadata上限を超えるため、有界binary envelopeの詳細方式が未決定。
7. **shortcut候補。** `Shift+H`は検討候補にすぎず割当未確定。KeyboardEvent.code、IME、NumLock、JISキーボード、入力欄・dialog／menuを含むWindows実機確認が必要。
8. **samplingと色定義。** LightCraftとJPEGで全画素／約1M sample、Y′係数が異なる。P1は各backend固有のnative Histogram表示とする提案であり、数値同一性は保証しない。
9. **実機性能・見た目。** Windows Desktop、RAW／非RAW、DX12／CPU fallback、Before／After、Draft／Full、zoom、Region、panel resizeについてGUIによる受入は未実施。P0の配列byte数は概算であり、時間・RSS・転送時間の測定ではない。
10. **ライセンス詳細。** 実際に移植するコード断片、著作権行、NOTICEの対応範囲をP2の対象選定時に再確認する。

## 12. P0結論と段階実装提案

**確認済みの事実。** JPEG Histogram UIと操作、Windows Native Preview lifecycle、Scope layout resizeはすでにある。LightCraft v0.20.0 Preview結果にHistogramが内在するが、現行Native API応答とGenzoRoom Windows Scopeは取得・表示を接続していない。Waveform／Parade／Vectorscopeの演算はChromaForgeに参考実装があり、固定LightCraftにはない。

**推奨。** P1はHistogramだけを完成させ、既存LightCraft集計をPreviewへ運び、JPEG版Scope UIとリサイズを利用する。P2でWaveformとRGB Paradeを共有集計として追加し、その後Vectorscopeを追加する。全4種類を一括必須にせず、P1で未使用の汎用scope基盤を設けない。この順序は既存実装の再利用度、Waveform／Parade間の集計共有、Vectorscopeの独立した変換・描画要件による推論である。

## 13. 後続工程記録

この節以降へP1／P2の実装、仕様決定、監査を時系列で追記する。P0本文・commit境界・調査対象SHAは履歴資料として維持する。

### 13.1 P1 — 記録欄

- 実装commit／日付：未記入。
- 確定したNative応答・Histogram意味：未記入。
- 変更ファイルと設計判断：未記入。
- テスト・build／artifact結果：未記入。
- 実機確認・残件：未記入。

### 13.2 P2 — 記録欄

- 実装commit／日付：未記入。
- Waveform／RGB Parade／Vectorscope実装範囲：未記入。
- ChromaForge由来コードとattribution：未記入。
- 性能計測と集計・scale仕様：未記入。
- テスト・実機確認・残件：未記入。
