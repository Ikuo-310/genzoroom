# 写真間の編集設定コピー＆ペースト統合・事前調査

2026-11-27。GenzoRoom `27df6ea010742ed7a6353fa81c72ea847d00dfe5`、LightCraft v0.20.0 upstream `192ff72923c39e6623f2c7ff67ab3a119deb8071` と現行 managed patch を対象とした。以下の upstream 行番号は固定 commit 基準。統合の責務は [LightCraft統合契約](LIGHTCRAFT_INTEGRATION_CONTRACT.md) に従う。対象は Windows Desktop の全設定コピー、選択コピー、ペースト、選択ペースト。比較資料の1・2枚目は LightCraft Desktop の編集メニューとグループ選択、3・4枚目は GenzoRoom Docker の Viewer メニューと個別項目選択。前の写真からのペーストと自動同期は今回の対象外。

**推奨**は、GenzoRoom がコピー時点の値をメモリに保持し、貼り付け先への部分適用を既存 `develop.merge` と GenzoRoom History に委譲する構成。選択粒度は C 案を第一候補とし、実装前に「全設定」の範囲、写真固有項目、WB の異種画像間の扱いを決める。LightCraft の選択単位と抽出を優先する場合も、一時プリセット経由の既存契約がある。現段階で managed patch は不要。

## A. LightCraft Nativeコピー＆ペースト機構

### ソースで確認した事実

| Engine command | 引数・対象 | 応答・副作用 |
| --- | --- | --- |
| `develop.copy` | `{groups?: SettingsGroup[]}`。選択中の active 写真から取得。指定時は Session の `copy_groups` を更新し、省略・null 時は現在の選択を再利用する | `{groups:[…]}`。値を `extract_groups` で取り出し、Session の `clipboard: Option<serde_json::Value>` を上書き。写真編集や History 追加は発生しない |
| `develop.paste` | `{ids?: PhotoId[], groups?: SettingsGroup[]}`。ids 省略時は Session の選択対象。groups 省略・null 時は保存した部分 JSON 全体、指定時はコピー済みグループとの積集合 | `{changed:n}`。選択ペーストではコピーを既定の設定へ一度適用し、対象グループを再抽出する。各対象には `apply_partial(…, 1.0)` を使い、写真ごとの `SetDevelop/PushHistory` を一つの Batch Undo にまとめる |
| `develop.pastePrevious` / `develop.sync` | 前の active 写真 / active から他の選択写真。コピー済み clipboard の転送経路には使わない | 前者は `{changed,from}`、後者は `{changed}`。Desktop の自動同期 UI と区別する |

出典は [cmd/develop.rs の groups_param](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs#L29-L34)、[copy / paste / sync](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs#L979-L1073)、[Session の clipboard](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/lib.rs#L308-L319)、[targets](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/lib.rs#L1437)、[commit](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/lib.rs#L661-L677)、[develop_op](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/lib.rs#L1069-L1098)。

コピー済み部分 JSON にコピー元への参照はない。元の PhotoId は抽出時だけ必要で、元の再編集・選択変更・Resident 退役後も同じ Session の値を使用できる。新規 Session は `clipboard=None`、`copy_groups=default_copy()` から開始する。OS clipboard を使わない。新規時の無指定コピーは20グループ中16グループ。Crop／Masks／Spots（Remove）／Red Eye は初期選択外で、全20グループを明示すれば対象にできる。 `version`、`process`、`disabled_sections` はどのグループにも入らない。「全設定」に見える Desktop の直接コピーも直前の選択に従う。GenzoRoom の「全設定」は固定した対象集合を指定する方が既存 JPEG の意味に近い。 [Session 初期化](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/lib.rs#L507-L512) · [SettingsGroup / extract_groups](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/presets.rs#L23-L130)

Desktop の `dialog.copySettings` と `dialog.pasteSettings` は `copy_groups` を初期選択にし、チェックリストは20グループを表示する。確認ボタンから Engine command を実行する。ペースト画面でコピー元に含まれないグループを選んでも、適用時の積集合には入らない。 `apply_partial` は `DevelopSettings::merged` を使い、オブジェクトを再帰マージし、配列を全体置換する。Native が範囲・カーブ・Crop を正規化し、復号エラーなら `apply_partial` は元の設定に戻る。 `changed` は生成した写真操作数で、同値ペーストも数えられる。GenzoRoom の no-op 判定には readback を使う。 [Desktop メニュー](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/ui-egui/src/menus/menubar.rs#L159-L171) · [ダイアログ起動](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/ui-egui/src/menus/run.rs#L1183-L1199) · [チェックリスト](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/ui-egui/src/dialogs/export.rs#L160-L190) · [確認](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/ui-egui/src/dialogs/confirm.rs#L211-L212) · [merge／正規化](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/lib.rs#L62-L104)

## B. Headless／MCP公開契約

| 方法 | 確認結果 |
| --- | --- |
| `command_list` / `command_run {id,params}` | Headless は Engine command の `develop.copy` / `develop.paste` を公開する。groups も指定できる。GUI の `dialog.*` は Headless のカタログに出ない |
| Native clipboard の直接持ち出し・注入 | `develop.copy` の応答はグループ名のみ。 `doc_inspect` に相当する状態照会の clipboard は有無の bool。固定版の公開カタログに Export/Import Clipboard はない |
| `develop.get {id?}` / `get_develop` | 指定写真の現在のフル設定 JSON（存在しなければ null 等の結果を処理）。 `process` を明示する。保存向け `to_json()` なので、`to_json_for_merge()` が補う値まで同じとは限らない。コピー時の選択は呼出側が扱う |
| `develop.merge {settings,label?}` | active 写真へ部分 JSON を適用。成功応答は JSON null。 `merge_settings_for_photo` で WB の片側のみを指定する場合に写真固有の解決を行う。Native のエラーと readback を別々に確認する |
| `preset.create {name,groups}` → `preset.export {path,ids}` → `preset.delete {id}` | 同じ `extract_groups` の結果を `.lcpreset` JSON の `presets[].settings` として取り出せる。 `presets.list` の応答はメタデータのみ。コピー用のファイルと一時 preset を作る副作用があり、Backend 管理パス・上限付き読込・後始末が必要。抽出した部分を別 Session の `develop.merge` へ渡せる。 `preset.apply` は量の補間やマスク追加等の別契約 |

出典は [MCP tools の登録／実行](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/mcp/src/tools.rs#L612-L653)、[query.rs の状態・develop.get・presets.list](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/query.rs#L115-L214)、[develop.merge / WB](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs#L115-L177)、[merge command](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs#L382-L391)、[preset.create](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs#L1206-L1216)、[preset.export](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/preset_files.rs#L87-L132)。

### 照合済みの実Native結果

EXE は `target-p1-sharpen/release/lightcraft-cli.exe`。隣接 receipt の固定 commit、version、契約番号と [manifest](../../../native/lightcraft/manifest.json) の patch 定義を照合した。実ファイルの SHA-256 は EXE `2e04fea8da7d84018baf7384043656af482a23986a1c63361f8200923e77eef7`、patch `a72ebfa66ce04b3aea5232b8d5a665ab8a4e0a1e2e169a8deb6286639778f974`。 `mcp --headless --compact` の v0.20.0 handshake、上記カタログ、構造化応答および Whole Preview の応答種別を確認。2つの隔離した一時 Session で合成 Bayer DNG 2点と生成 JPEG を使用し、XMP 自動書込みを無効にした。

| 検証 | 実応答・readback |
| --- | --- |
| DNG から既定コピー → JPEG に通常ペースト | コピーは前述の16グループ。JPEG は `exposure=1.25`、`saturation=41`、`wb={mode:"custom",scale:"kelvin",temp:5300,tint:8}`。元の `disabled_sections:["light"]` は転送されず、先は `[]`。Native Undo／Redo はともに Paste Settings を返し、exposure は 0 → 1.25 と復元。同値で繰り返しても `{changed:1}`、readback は完全一致 |
| `groups:["light","color"]` コピー → 元を再編集・退役 → 選択ペースト | 無指定の再コピーも同じ2グループを返した。コピー直後の exposure 1.25 を元で 2 に変更し、MCP `headless_release_photo` / `headless_retire_photo` は `{released:1}` / `{retired:1}`。DNG へ `["light","whiteBalance"]` で貼ると `{changed:1}`、exposure はコピー時の 1.25、非選択の saturation は −15、ペースト先の disabled_sections は ["color"] を維持 |
| セッション再生成後に外部 snapshot を適用 | 新 Session の Native `develop.paste` は無効で実行拒否。別プロセスに保持した JSON の `light.exposure` 等の `develop.merge` は null 成功。JPEG／DNG とも exposure 1.25、先の contrast −17 を保持。 `get_develop` で省略された元の `detail.nr_outliers=false` は、先を真にしてから Detail を送っても真が残った |
| 既存のグループ抽出 | `preset.create` で Light／Detail／Profile を指定し、 `preset.export` は `count:1`。ファイルは `format/version/presets`、Detail に明示的な `nr_outliers:false` があった。試験用 preset は削除した |
| JPEG → DNG の WB と Full Preview | JPEG で `wb:{mode:"custom",temp:20,tint:7}` を適用後に読んだ値は `temp:2000,tint:7`、scale 省略。その WB 全体を DNG に送ると同じ JSON を返した。Whole `render_preview` に `include_frame:true, quality:"full", max_side:128` を渡し、JPEG 96×128／DNG 128×96 とも image と text、メタデータ `kind:"after",quality:"full"` を取得した。画素や色の等価性は未判定 |

## C. GenzoRoom既存JPEG実装

| 確認箇所 | 現行動作と再利用候補 |
| --- | --- |
| [editClipboard.ts](../../../frontend/src/editClipboard.ts#L3-L31) | 1タブのモジュールメモリに `values` と元 Asset ID／ファイル名を複製して保持。全16数値、選択数値、Slider／カテゴリからの部分コピーが同じスロットを上書き。無効化中の値も保持する。タブ内の写真切替・Home・現像再入場をまたぎ、reload／close で消える。寿命・所有者を再利用し、値形式に engine 判別を加える候補 |
| [AdjustmentSelectionDialog](../../../frontend/src/AdjustmentSelectionDialog.tsx#L22-L122)・[項目定義](../../../frontend/src/adjustmentSelection.ts#L8-L29) | Color／Basic／Color Grading の親子チェック、親の中間状態、全選択／全解除、空の確定禁止。Paste はクリップボード所収の項目だけ（値がゼロでも対象）。初期値は毎回全候補を ON。選択自体の記憶はない。 `showModal`、Tab ループ、Escape、Enter／Space、フォーカス復帰を再利用し、候補定義と型をエンジンから渡す |
| [EditSettingsMenu](../../../frontend/src/EditSettingsMenu.tsx#L91-L126)・[ImageViewer](../../../frontend/src/ImageViewer.tsx#L716-L792) | Viewer の `⋯` とコンテキストメニューの四操作、clipboard がない時の Paste 無効、registry 由来の表示。写真切替・退出保存・失敗・選択／History ダイアログ等は [AnshitsuPage](../../../frontend/src/AnshitsuPage.tsx#L310-L359) と [操作ガード](../../../frontend/src/AnshitsuPage.tsx#L408-L498) が判定。四操作のコールバックの形とキーバインドを再利用可能 |
| [editing.ts の Paste](../../../frontend/src/editing.ts#L205)・[EditHistory](../../../frontend/src/EditHistory.tsx#L29) | 保留中の編集を先に確定し、該当する数値だけ変更。23の有効フラグはペースト先を維持。変更時のみ1 History 項目、元ファイル名と対象 ID を記録。無変更では Paste 項目も Redo 切断もない。JPEG reducer、Recipe v18、Slider／カテゴリ／色域ごとの固有対象は JPEG の契約として維持 |

コピーは Viewer では全設定、フォーカスなどから Slider／カテゴリ／色域が対象となる場合は文脈に応じた部分。通常ペーストの window keydown は Viewer にフォーカスが戻っていなくても動作し、選択操作は Viewer のハンドラが担当する。現 Windows の `AnshitsuPage` は `useDevelopmentEngine()` の LightCraft 選択で RAW と JPEG を `useRawDocument` に渡し、旧 JPEG の編集コールバックだけでは利用可能にならない。現回帰範囲は [AnshitsuClipboard.test.tsx](../../../frontend/src/AnshitsuClipboard.test.tsx#L387) の写真切替／4操作／Undo／Redo／入力保護／no-op と [選択ダイアログテスト](../../../frontend/src/AdjustmentSelectionDialog.test.tsx)。

## D. コピー対象と選択粒度

グループは Desktop 画面だけの分類ではなく、`groups` 引数の列挙型と抽出キーの境界。任意の葉を指定する機能は `develop.copy/paste` にはなく、Headless の部分 JSON と Control API にはある。以下の Control 単位の可否はソースに基づく。GenzoRoom での対応は設計候補で、個別項目の動作を網羅測定した結果ではない。 [SettingsGroup::keys](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/presets.rs#L91-L130) · [DevelopSettings](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/settings.rs#L124-L165) · [GenzoRoom Control 定義](../../../backend/raw_controls.py)

| 対象 | LightCraft 選択単位・JSON | 葉の適用可否と選択候補 |
| --- | --- | --- |
| 基本補正 | `light` → `light,hdr` | 露光量、コントラスト、ハイライト、シャドウ、ホワイト、ブラックは独立数値。個別選択しやすい。HDR は別のまとまりとして扱う候補 |
| WB | `whiteBalance` → `wb` | 温度・Tint 単独 merge は Native にある。モード／scale／as-shot の連動があるため `wb` 一体を第一候補 |
| 自然な彩度・彩度 | `color` → `color` | `vibrance/saturation` を個別適用可 |
| ポイントカーブ | `toneCurve` → `curve` | master／RGB のチャンネル配列を個別に渡せる。配列全体が原子で、点単位の合成を避ける。初期候補はカーブ全体 |
| カラーミキサー | `colorMixer` → `mixer,bw_mix,point_colors` | RGB/HSL バンド・葉は個別 merge 可能。未設定バンドの既定値も考慮。提案はミキサー単位、B&W は Treatment との組合せを確認 |
| Point Color | `colorMixer` の `point_colors` | JSON 配列を一括置換できる。空配列は明示削除。順序・重複・小数を維持。インデックス単位の貼り付けは位置の意味が異なるため選択対象にしない候補 |
| カラーグレーディング | `colorGrading` → `grading` | shadows／midtones／highlights／global の葉や色域単位は指定可能。共通設定（blending／balance 等）と組で効果が変わる。初期候補は全体、色域＋共通項目の別選択も可能 |
| 基本エフェクト・周辺光量 | `effects` / `vignette` | 独立数値の部分適用可。周辺光量は style と数値を一体にする候補。Grain は独立グループ |
| シャープネス・輝度NR・カラーNR | `detail` → `detail,enhance` | `sharpen_*`、`nr_luminance/detail/contrast`、`nr_color/color_detail/color_smoothness` の葉を適用可。各サブカテゴリ一体を候補。 `nr_outliers` と `enhance` の包含は明示決定 |
| レンズ補正・色収差補正 | `optics` → `optics` | 補正 ON/OFF、量・色範囲は指定可。プロファイル有効化と量、Defringe の上下限等はまとめる。実プロファイルは先の写真から解決 |
| キャリブレーション | `calibration` | 7数値の葉を適用可。初期候補は同一グループ |
| ローカルトーンマッピング | `profile` → `profile.camera_local_tone` | bool は個別 merge 可、OFF は `false` の明示が必要。Profile ID と Amount を移さず個別選択できる |
| クロップ・水平補正・ジオメトリ | `crop` → `crop,orientation` / `geometry` → `geometry` | Native の専用コマンドと設定入力がある。切り抜き、角度、座標枠、Orientation は一体扱い。別写真の角度だけを当てる場合、専用 Straighten と JSON merge の意味を同一視しない |
| その他の Native 設定 | `profile,treatment,grain,masks,spots,redEye,lensBlur` と上記各グループ内 | 未公開でも既定コピーに Profile、Treatment、Grain、Lens Blur、Enhance、Geometry 等が含まれる。ピクセル修復やマスクは明示選択時。 `version,process,disabled_sections` は全20でも対象外 |

### 依存関係と貼り付け先の扱い

- **WB。** `asShot` は先の写真の as-shot 白を使う。Kelvin RAW のプリセットモードも Native が写真情報から解決し、Custom や Auto の値には scale が関わる。Native `develop.merge` の特別な変換は片側だけを渡す条件を持ち、両方を渡した時に結果の scale を変換する契約はない。先のカメラ初期値・マトリクスは保持し、GenzoRoom で色温度換算を行わない。形式をまたぐ WB を初期対象に含める場合、readback 後の操作可否も検証する。 [effective_wb / legacy_wb](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/pipeline/src/local.rs#L70-L98) · [merge_settings_for_photo](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs#L119-L177) · [GenzoRoom WB 契約](WB_NATIVE_CONTRACT.md)
- **ON/OFF。** `disabled_sections` は文字列配列全体が置換単位。Native グループ抽出と同様、最初はペースト先のカテゴリ状態を保持する。フラグ自体が編集項目の `optics.remove_ca`、`optics.lens_profile`、`profile.camera_local_tone` 等は選択ポリシーに従う。コピー範囲に OFF が含まれるときは省略と `false` の差を吸収する。 `to_json_for_merge` が補う `detail.nr_outliers`、`camera_local_tone`、既定 HDR やゼロ HSL バンド等の serde 省略は、実際に対応する項目だけ確認する。既存完全復元用 `complete_snapshot_for_merge` は Mixer や Detail を自動追加するため、部分ペースト全体への適用は選択を壊す。 [Native to_json_for_merge](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/lib.rs#L34-L52) · [完全復元補完](../../../backend/raw_controls.py#L108-L134) · [Section操作](../../../backend/lightcraft_raw.py#L2593-L2677)
- **プロファイル・画像寸法。** 写真依存の埋込みレンズ補正は写真レコード側にあり、Optics には有効フラグと量が入る。先の写真の機材と Native レンズ解決を使う。Profile ID は設定値だが、外部 LUT の実体やローカルトーンのカメラメタデータはコピーに含まれない。Crop の正規化範囲や Orientation は写真の縦横・画像寸法に依存し、別写真への同構図を保証できない。Geometry は通常コピーに入る Native グループだが、含める場合は Crop／Orientation／マスクへの影響を確認する。 [EmbeddedLens](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/settings.rs#L720-L744) · [Native レンズ refresh テスト](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/tests/lens_refresh.rs#L25-L66) · [GenzoRoom Geometry](../../architecture.md#native-crop-editing-preview-contract-1-phase-1)
- **Process／未知の項目。** `version` は schema、`process` は描画処理バージョン。両方とも貼り付け先を維持する。フル Recipe の未知項目は既存 restore 契約に従って保持する。コピー対象に含める範囲は UI と Native 契約で決める。未公開設定を含むグループを丸ごと適用する場合は、表示や保存の受入条件も同時に決める。 [Native Process テスト](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/tests/process.rs#L125-L174)

## E. 選択ダイアログ設計比較

| 案 | Native 再利用と整合性 | 表示量・操作性 | 実装と保守 |
| --- | --- | --- | --- |
| A. LightCraft グループ準拠 | 最大。一時 preset から Native 抽出を利用でき、既存グループと同じ境界 | LightCraft 参考画像のような短い一覧。露光量だけ等の選択ができない | 少ない選択定義。グループの追加に追従しやすい。preset の I/O と寿命管理、Native が選んだ未公開設定の受入確認が必要 |
| B. GenzoRoom JPEG と同じ個別選択 | `develop.merge` は利用できるが、グループ抽出の再利用度は低い。WB・補正・配列の連動を UI に持ち込む | 数十以上の候補。特定パラメーターを移す自由度が高く、スクロールと選択の負担も大きい | 項目の定義、ラベル、依存関係、serde 省略の追従が最大。追加 Control ごとに見直し |
| C. 独立値とまとまりの混合 | 基本補正・彩度は既存 Control ID を再利用し、WB、カーブ、Point Color、グレーディング等はまとまりを保つ。 `develop.merge` に委譲 | Docker 参考画像の個別選択と親子選択を必要な場所で利用できる | 対応 Control を限定すると A と B の中間。項目定義ごとに既存パスと既知の省略値を確認し、カテゴリ丸ごとの Native 抽出を優先する場合は A の経路を評価 |

第一候補は C。初期対象を決めた上で、独立した Basic／Color の個別対応が小さな投影で済むことを確認する。対応のために写真固有値の変換や広範な合成が必要になる項目は A 相当のまとまりを優先する。選択コピーのデフォルト、前回選択の記憶、全コピー対象と選択コピー候補の一致は未決定。選択ペーストは既存 JPEG のように、コピー済みの候補だけを表示し、毎回全候補 ON を初期案とする。

## F. Desktop編集メニュー

現行は Tauri の `File / View / Help`。 `on_menu_event` が固定 ID から `dispatch_main_event` を使う。main WebView で `CustomEvent` 等を購読する既存パターンがあり、言語は `SettingsDialog` → `__GENZOROOM_DESKTOP__.setMenuLanguage` → `set_native_menu_language` → Rust の日英ラベル表。Preferences／Exit は Native accelerator 付き。編集操作の状態同期は未実装。 [menubar 構築と dispatch](../../../desktop/src/main.rs#L155-L216) · [言語実装](../../../desktop/src/main.rs#L297-L385) · [Desktop bridge](../../../desktop/src/lifecycle.rs#L6-L16) · [Frontend 言語同期](../../../frontend/src/SettingsDialog.tsx#L38-L66)

**設計案。** `Edit / 編集` に「編集設定をコピー / Copy Edit Settings」「選択してコピー… / Choose Settings to Copy…」「編集設定をペースト / Paste Edit Settings」「選択してペースト… / Paste Selected Settings…」を設け、固定コマンド ID を main WebView の現像 owner が受信する。Viewer・ショートカット・Native メニューから同一の四操作を呼ぶ。Frontend から Desktop bridge へ availability を送り、Rust が当該項目の有効状態を反映する。初期・現像離脱・ページ再読込・別ウィンドウ、設定ダイアログ等では無効。Frontend 側で実行直前に現行 owner、文書の準備完了、同一エンジンの payload、未確定操作、保存／復旧、写真切替、退出を再確認する。表示状態の更新が遅れた場合でも後継 Document へ古い操作を送らない。Undo／Redo を載せる場合は既存 `rawHistoryAction` と `canUndo/canRedo` を使い、History メニュー配置は別途決定。Docker は既存 Viewer/キーバインドを利用する。 [現行 History ゲートと操作](../../../frontend/src/AnshitsuPage.tsx#L335-L348)

## G. ショートカット調査

| 操作 | 維持する候補 |
| --- | --- |
| コピー／ペースト | Windows の Ctrl+C／Ctrl+V（registry の Primary） |
| 選択コピー／ペースト | Windows の Ctrl+Alt+C／Ctrl+Alt+V（Primary＋Alternate）。Desktop と Docker 共通 |

現行 registry で Shift 版の照合定義は作れる。Windows の Firefox、Chrome、Edge は公式資料で Ctrl+Shift+C を Inspector／Elements の起動に割り当てる。Firefox と Edge は Ctrl+Shift+V を書式なし貼り付けに割り当てる。Chromium の Ctrl+Shift+V は編集時の貼り付けコマンドとして扱われる。ブラウザーが先に処理するキーやページへ来ないイベントは、ページの `preventDefault()` で一律に抑止できない。WebView2 にもブラウザー用 accelerator があり、ホスト処理が Web コンテンツに先行し得る。公式資料とソースの確認で、実ブラウザー・WebView2 の優先順をこのリポジトリで動的検証した結果はない。 [Firefox](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly) · [Chrome DevTools](https://developer.chrome.com/docs/devtools/shortcuts) · [Chromium の編集キー定義](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/editing/editing_behavior.cc) · [Edge DevTools](https://learn.microsoft.com/en-us/microsoft-edge/devtools/shortcuts/) · [Edge 貼り付け](https://support.microsoft.com/en-us/edge/keyboard-shortcuts-in-microsoft-edge) · [WebView2 accelerator](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2acceleratorkeypressedeventargs) · [preventDefault](https://developer.mozilla.org/en-US/docs/Web/API/Event/preventDefault)

**設計案。** 四操作の Tauri MenuItem には accelerator を登録せず、必要なら registry の表示ラベルをメニューに反映する。実行キーの owner は Frontend とし、Native メニューのクリックはコマンド ID を送る。現行の `defaultPrevented`、IME、repeat、AltGraph、対応修飾キー、入力欄／contenteditable ガードを共有し、数値スライダーの range と数値テキスト欄を区別する。Viewer で処理したイベントは既存ルートの抑止によって window で二重実行させない。入力欄の OS コピー／ペースト、通常のメニューキーボード操作、ウィンドウフォーカス復帰を Windows 手動確認に含める。 [editShortcuts.ts](../../../frontend/src/editShortcuts.ts#L4-L41) · [イベント照合](../../../frontend/src/editShortcuts.ts#L111-L123) · [Viewer keydown](../../../frontend/src/ImageViewer.tsx#L761-L796) · [統合回帰](../../../frontend/src/AnshitsuClipboard.test.tsx#L607-L640)

## H. Workspace／Session・Recipe／History統合

コピー元の取得方法は [M節の追加調査](#m-追加調査コピー元の確定済みsnapshot) で更新した。以下の表は初回調査時の設計案を記録している。

| 場面 | 提案 |
| --- | --- |
| コピー時 | 現像 owner の通常の編集排出境界で確定し、Backend の現行 handle／revision から設定を取得。 `RawSettings` は UI 用投影なので、完全な Native JSON が必要な範囲は Backend 経由で取得する。コピー専用の読み取り契約に選択 ID を渡し、エンジン識別子・選択 ID・値を detached payload として既存メモリに差し替える。元の Asset ID／ファイル名は表示・履歴メタデータ。失敗・キャンセル・切替後の遅延応答は現在の clipboard を上書きしない |
| A → B・退役・Native 再生成・Workspace 再作成 | clipboard の寿命は Frontend のモジュール。Native PhotoId／handle／Session への参照を保持しない。コピー元の再編集と切替・退役・再生成は値を変えない。ページ reload／アプリ終了で消える。異種エンジンは合成せず同一 engine の候補だけを利用 |
| ペースト時 | 選択ペーストは開始時点の clipboard を束縛し、確定時に対象 Asset ID と Document owner を再照合。その他の操作と同じ `RawRecipeSaver.operate` → `/history/operate` → `RawPreviewApi` → `LightCraftRawSession._mutate` の境界で一度の部分 `develop.merge` と Native readback。先の対象外設定は Native の部分適用で保持する |
| 履歴と保存 | 本文の部分 payload は操作入力として検証し、 `metadata` には許可された小さい元情報だけを記録。許可済み項目・型・サイズ、Document handle／workspace／generation／token／revision、settings fingerprint と Recipe revision を既存の保存 ID・排他・再試行と同じ境界で検証。Native の `changed` を使わず、保存前後の設定が同一なら Paste History 項目を増やさず Redo を維持する。保存 receipt や revision の扱いは store の既存契約に従う |
| Undo／Redo／Jump・描画 | 前後の確定 snapshot を既存 History に保存し、Undo／Redo／Jump は既存の snapshot 復元を使う。再訪は保存済み Recipe を復元し、Whole と Region は確認済み revision/fingerprint に更新。Export は Queue が凍結した先の Recipe を別 Session に復元する。clipboard の値を画像処理系に直接渡さない |

既存の `RawRecipeSaver` は操作の直前に保留操作・保存を排出する。Crop／Curve／Mixer／Point Color などの特殊 Interaction は完了またはキャンセルを既存 owner に任せ、正常な確定まで貼り付けをガードする。再送は同一 save ID と同一入力の再照会を利用し、送達不明時は既存の readback・復旧を優先する。Native の内部 History は実行に伴う副作用として扱い、UI の Undo/Redo は GenzoRoom の保存済み History に接続する。ログは操作の開始／失敗／確定、engine、revision、saveId、項目数、転送バイト数程度とし、clipboard／Recipe 本文は収集しない。

根拠は [写真切替・Session設計](FILMSTRIP_SESSION_OPTIMIZATION.md)、[RawDocument の操作と Undo](../../../frontend/src/useRawDocument.ts#L1840)、[RawRecipeSaver.operate](../../../frontend/src/rawRecipeSave.ts#L727)、[RawSettings 投影／操作型](../../../frontend/src/rawApi.ts#L88)、[RawPreviewApi の予約・readback・保存](../../../backend/windows_raw_api.py#L1709)、[Native mutation と部分 merge](../../../backend/lightcraft_raw.py#L2206)、[merge_settings](../../../backend/lightcraft_raw.py#L2800)、[store の append と Redo 切断条件](../../../backend/raw_recipe_store.py#L953)、[Export 復元](../../../backend/raw_export_artifact.py#L379)。

## I. 現像エンジン間の互換性

| コピー元 → ペースト先 | 評価 |
| --- | --- |
| LightCraft RAW → LightCraft RAW | 現行 Native group copy/paste と別プロセスへの部分 JSON 適用を合成 DNG で確認。実カメラ間の WB、機材補正、Geometry は受入確認が必要 |
| LightCraft RAW → LightCraft JPEG | Native グループペースト、別プロセスでの部分 JSON と Preview を確認。RAW 固有項目が JSON に保持されても JPEG で同じ結果になる保証はない |
| LightCraft JPEG → LightCraft RAW | WB JSON の Native readback と Preview を確認。形式間で数値や scale の解釈が同じであること、GenzoRoom の WB UI が引き続き編集可能であることは別条件 |
| LightCraft JPEG → LightCraft JPEG | 同じ `DevelopSettings`／部分適用契約で実現可能。今回の probe は JPEG 1枚で、JPEG 2枚間の端末間受入は未実施 |
| 既存 JPEG → 既存 JPEG | Docker の現行機能。16値・History の既存回帰テストを維持 |
| LightCraft ↔ 既存 JPEG | 別エンジンの明示的な型で管理し、ペースト候補から外す。調整量の単位、WB、グレーディング、フラグの意味が異なる |

## J. managed patchの要否

**現時点では不要。** C 案の対応済み項目なら `develop.get` の投影と `develop.merge` を利用できる。全グループの抽出を Native へ優先委譲するなら既存 `preset.create/export/delete` が使える。 `develop.get` の投影を選ぶ場合、実測で差が出た `nr_outliers` 等の既知の省略値を、選択した範囲だけ明示できることが条件。既存の完全 snapshot restore は別用途で、貼り付け先を reset してから適用する案は採用しない。

将来、公式グループの挙動との一致が必須となり、既存の一時ファイル契約が採用できない具体的な理由が生じた場合に限り、最小公開案として read-only `develop.extract {id?,groups?} → {groups,settings}` を検討する。既存の `extract_groups` を呼び出してコピー値を返すだけとし、Session 間の clipboard 共有や新規の設定適用エンジンは不要。フォト固有情報や OS clipboard を公開する必要もない。 [現行 managed patch](../../../native/lightcraft/patches/0001-v0.20.0-whole-frame.patch) · [接続API原則](LIGHTCRAFT_INTEGRATION_CONTRACT.md#接続api)

## K. 推奨実装工程

| 工程 | 変更対象・再利用 | Native patch | テスト・完了条件 |
| --- | --- | --- | --- |
| 1. 四操作を End-to-End で接続 | 選択範囲を決定し、Backend に認証付きの取得と History Paste 操作を追加。Frontend は clipboard の寿命、選択 dialog、Viewer／registry、 `useRawDocument`・saver を再利用。Docker JPEG の reducer と既存選択を維持 | 不要 | Backend で revision／認証／非対象保持／OFF・空配列／適用後 readback／同値・Redo・Undo／Jump／別 Session／再訪を確認。Frontend で四操作、別写真／異エンジン、遅延応答、ダイアログ操作、編集欄を確認。Preview／Region は既存 revision 無効化、Export は凍結 Recipe の引渡しを重点確認。Windows 実機で RAW/JPEG それぞれの A→B、RAW↔JPEG、保存・再訪、表示更新を確認 |
| 2. Desktop メニューを接続 | Tauri menubar に四操作を追加し、日英・コマンド dispatch・有効状態を既存 bridge と現像 owner に接続。要件に含める場合は Undo/Redo も同時に接続 | 不要 | Rust の日英メニュー／bridge と Frontend の状態同期・ハンドラ共用・画面遷移を確認。Windows 実機で初期無効、切替、保存中、ダイアログ、キーとクリックで一度だけ実行、通常の入力コピーを確認。Docker の Viewer 操作は既存テストを再実行 |

工程1は Backend の契約・操作ルートと Frontend 呼出しを同じ機能 commit に入れ、利用側だけが先に main に入る状態を避ける。工程2は工程1が動く時点の追加 UI として別 commit にできる。検証は関連する RAW History／Recipe／Export、Frontend Clipboard／Shortcuts、Tauri メニューに限定し、TypeScript・適用ビルド・diff check を行う。推奨実装の受入条件であり、この文書の作成時点で製品コードの試験はしていない。

## L. 未確定仕様・未確認事項

- **決定が必要。** A/B/C の確定、全設定に含める範囲（公開項目、画像固有項目、未公開の Native 設定）、ON/OFF と Crop／Geometry／Orientation の扱い、前回選択の記憶、RAW↔JPEG の WB 選択・警告の要否、Undo/Redo の Edit メニュー配置。初期提案は C、ペースト先のカテゴリ状態・処理バージョンを維持、Crop・マスク・修復は既定の一括対象から外す。
- **限定試験の残り。** 実機材・異なるレンズ、外部プロファイル、RAW/JPEG それぞれの既定設定と異なる Orientation／アスペクト、JPEG 2枚間、選択された値の保存・失敗時の復旧、実ブラウザーと Tauri／WebView2 のキー優先順・フォーカス。今回実施したのは Native MCP の限定試験とソース調査で、GenzoRoom の新規 Paste を介した Region／Export Queue の実動作、手動 Desktop／Docker 画面と配布環境は未確認。

## M. 追加調査・コピー元の確定済みsnapshot

GenzoRoom `ddf334333cc44402b4d33dd9c5001534ff45f82a` のソース調査。以下の A／B はコピー元の取得方法を指す。E節の選択粒度とは独立した判断。

**更新した推奨。** コピー操作時は B 案を採用し、Backend が現在の Document に保持する完全な確定済み readback を `LightCraftRawSession.confirmed_settings(handle, expected_revision)` で取得する。通常の編集・保存・復元で既に得た snapshot を使い、コピー固有の `develop.get`、毎回の SQLite 読込、Frontend の完全設定常駐を避ける。History／Recipe が確定済みならこの readback と同じ設定がコピー元となる。DB 行が作成される前は、同じ関数で当該写真の Import または復元済みの readback を取得できる。H節の Backend 経由・選択済み部分の返却・遅延応答ガードは維持し、取得元を Native 再照会から既存 snapshot に変更する。適用は従来案どおり `develop.merge`、Native readback、既存 History／Recipe 保存を使う。

### M.1 現行の三つの設定表現

| 保持場所 | 内容と保証 |
| --- | --- |
| **Backend の現在の Native Document** | 通常の Import、編集、復元の `develop.get` を `_read_settings` で読み、`_commit` が完全な `_Photo.settings_json` と `applied_revision` を一緒に確定する。 `confirmed_settings` は Native command を送らず、この JSON を含む `DevelopSnapshot` を返す。active handle、同じ generation、同期状態、期待 revision を確認し、Curve／Mixer／Point Color の未完了 Interaction も拒否する。 [readback と commit](../../../backend/lightcraft_raw.py#L925-L944) · [snapshot](../../../backend/lightcraft_raw.py#L884-L888) · [confirmed_settings](../../../backend/lightcraft_raw.py#L1240-L1260) · [owner と Interaction](../../../backend/lightcraft_raw.py#L804-L868) |
| **SQLite の History／Recipe** | 現 cursor が 0 の時は `baselineSettings`、それ以外は `steps[cursor-1].settings`。 `_read_history` は選択 snapshot と現在の Recipe 本文の正規 JSON の一致および保存 receipt を検証する。append または cursor move は同一トランザクションで Recipe と History を更新する。両者の一致は保存済みデータの保証で、進行中の Native 編集まで含めた同時一致ではない。 [store の cursor／Recipe 検証](../../../backend/raw_recipe_store.py#L760-L814) · [保存処理](../../../backend/raw_recipe_store.py#L923-L1007) |
| **Frontend の表示用データ** | `RawSettings` は公開 Control の `values`、カーブ、Point Color、Crop、WB の公開項目などの投影。全 `DevelopSettings` を持たない。History 一覧は `stepId/kind/metadata/createdAt/changes/flagChanges` と cursor 情報のみ。Recipe GET も revision・fingerprint 等のメタデータ。個別の公開 Control は既存値で取得できるが、Native のグループ全体や未公開の値を含むコピーをこれらの型だけで正確に構成できない。 [controls_state](../../../backend/raw_controls.py#L385-L423) · [Recipe GET](../../../backend/windows_raw_api.py#L1317-L1336) · [History 投影](../../../backend/windows_raw_api.py#L1623-L1652) · [Frontend 型](../../../frontend/src/rawApi.ts#L88-L99) · [History の表示項目だけを保持](../../../frontend/src/rawApi.ts#L627-L639) |

確定済み Document と永続 snapshot の一致は、Backend の Document revision／settings fingerprint、Recipe revision、保存結果の照合で成立する。 `_history_public` は同期状態と正規化後の設定 fingerprint を比較する。Frontend の `sendHistory` は現 owner、送信した saveId、現在の Recipe と ACK の revision／fingerprint、cursor、pending の解消を照合してから確定を受け入れる。古い receipt の再取得だけでは現在の一致証明にならない。比較は Native adapter の正規化を踏まえた設定の一致であり、Native の応答バイト列と保存 JSON の完全同一性を要求しない。Recipe がまだ存在しない場合、`nativeMatchesRecipe` の基準は Document 上の初期 fingerprint へフォールバックするので、この bool だけで永続行の存在を判定できない。 [Backend の正規化と照合](../../../backend/windows_raw_api.py#L1309-L1315) · [History 公開状態](../../../backend/windows_raw_api.py#L1430-L1442) · [Frontend の ACK 照合](../../../frontend/src/rawRecipeSave.ts#L1050-L1082)

### M.2 状態別の取得可否

| 状態 | 現行動作とコピーの扱い |
| --- | --- |
| **初回、History 行なし** | Import 中の readback を Backend が確定する。既存 Recipe があれば Document 公開前に検証・復元し、History 行がなければ store はその Recipe を暫定 baseline として返す。新規写真では既存の自動初期化が Import 時点を cursor 0 として保存する。コピーは DB 行作成を強制しない。Document が同期済みで保留編集や初期化中の保存がなければ、確定済み Import readback がコピー元になる。P1-A は復旧 pending 中の取得を拒否し、復旧完了後の現行 snapshot のみを取得する。 [Import](../../../backend/lightcraft_raw.py#L1128-L1159) · [Document の Recipe 復元](../../../backend/windows_raw_api.py#L2052-L2111) · [暫定 baseline](../../../backend/raw_recipe_store.py#L819-L834) · [Frontend の初期化](../../../frontend/src/useRawDocument.ts#L835-L843) |
| **スライダーに未確定の入力がある** | `RawControls` の desired／送信待ちと Backend の確定済み readback は別。通常の確定は controls の flush／settle と saver の commit／ACK を経る。現像 owner でその確定を待つか、完了までコピーを無効にする。コピー用の HTTP で UI の送信待ちを確定することはできない。退出用 `prepareSave` は表示停止・freeze／pause を伴うため、コピーでは通常編集の確定境界を再利用する。 [RawControls](../../../frontend/src/rawControls.ts#L63) · [settle/unsettled](../../../frontend/src/rawControls.ts#L137-L154) · [saver の flush と保存](../../../frontend/src/rawRecipeSave.ts#L960-L990) · [退出時の排出](../../../frontend/src/useRawDocument.ts#L1832-L1860) |
| **Curve／Mixer／Point Color／Crop 等の途中** | Native の一時値や Draft をコピーしない。通常の Finish／Cancel を owner に任せ、確定または取消後だけ取得する。Native の Interaction ガードに加え、Backend の `_history_unsettled` が管理する Crop gesture と未完了 History 保存をコピー境界でも確認する。 [Native Interaction ガード](../../../backend/lightcraft_raw.py#L838-L868) · [Backend の保留判定](../../../backend/windows_raw_api.py#L1399-L1403) · [保存後の Interaction 確定](../../../backend/windows_raw_api.py#L1896-L1914) · [Frontend の dirty／locked](../../../frontend/src/rawRecipeSave.ts#L706-L712) |
| **Undo／Redo／Jump 直後** | Backend は現在の revision／fingerprint と Recipe revision を照合し、行先の History snapshot が現在値と異なれば Native に復元して readback を照合する。cursor と Recipe を同時に保存し、確定 ACK 後に Frontend が新しい設定と cursor を受理する。同じ値への移動などは Native revision が変わらない場合があるので、保存完了と現行 Recipe revision も見る。コピー元は移動後の readback。 [対象 snapshot の決定](../../../backend/windows_raw_api.py#L1705-L1750) · [復元と保存](../../../backend/windows_raw_api.py#L1823-L1891) · [Native 復元の readback 照合](../../../backend/lightcraft_raw.py#L2190-L2204) |
| **保存中・失敗・応答不明** | 一時的に readback が保存済み cursor より先行する。同じ snapshot を読めても未完了の値を通常コピーとして公開しない。保存完了を待ち、失敗・応答不明・混在した owner はコピーを無効にして既存 Retry／復旧に任せる。コピーのために Native へ再照会しても SQLite の確定は証明できない。 [History 排他・復旧](../../../backend/windows_raw_api.py#L1399-L1428) · [永続 Recipe からの recover](../../../backend/windows_raw_api.py#L1998-L2026) · [保存結果の検証](../../../frontend/src/rawRecipeSave.ts#L1050-L1082) |
| **写真切替・Native 再生成** | 開いている Document の handle／generation／token が変わる。再生成では旧 owner の確定状態を保存してから新しい Document を開き、Recipe 復元後の fingerprint／Recipe revision を照合して owner を入れ替える。閉じた／切り替わった owner のコピー応答は捨てる。完了済み clipboard は detached 値なので、Resident の退役や再生成をまたいで使用できる。 [Backend の現行 Document 判定](../../../backend/windows_raw_api.py#L525-L532) · [再生成](../../../frontend/src/useRawDocument.ts#L1004-L1051) · [Frontend の現行 owner](../../../frontend/src/useRawDocument.ts#L1682-L1687) |

### M.3 完全性・精度と省略値

Backend の readback と store は UI Control の一覧へ絞らず、サイズ、型、有限値等を検証した JSON を保持する。保存時はプロパティを正規 JSON に整形するが、UI の表示桁・slider step で値を丸めない。未公開フィールドのうち保存契約を満たすもの、配列の順序・重複・小数は保持される。古い永続 snapshot には収録されていないフィールドがあり、restore は adapter の既定値補完を経て現在の engine view を検証する。この点でも、現行 Document の readback は DB の旧 JSON を直接コピーするより適している。 [Native の設定検証](../../../backend/lightcraft_raw.py#L394-L416) · [Recipe の検証・保存](../../../backend/raw_recipe_store.py#L67-L127) · [旧 Recipe の restore](../../../backend/lightcraft_raw.py#L2834-L2863) · [完全設定の保存回帰](../../../backend/tests/test_raw_recipe_store.py#L109) · [Point Color の精度回帰](../../../backend/tests/test_raw_controls.py#L96)

完全な readback は `DevelopSettings` の保存向け表現であり、省略可能なキーをすべて列挙した JSON ではない。コピー時に Native へ `develop.get` を再送しても同じ省略がある。初回調査では `detail.nr_outliers=false` の省略を実測した。`profile.camera_local_tone=false` やゼロ Mixer バンド等も含め、既知の省略値は、コピー対象に含めると決めた場合だけ、そのフィールドの既定値を明示する。空の Point Color 配列も「選択して空をコピー」と「選択外」の意味を区別する。全量復元用 `complete_snapshot_for_merge` は対象外のグループも補い得るため、部分 payload 全体には適用しない。 [B節の実測](#b-headlessmcp公開契約) · [既存の完全復元補完](../../../backend/raw_controls.py#L108-L143) · [Point Color の旧 snapshot 回帰](../../../backend/tests/test_raw_history_api.py#L760)

### M.4 方式比較と必要なAPI

追加通信は、すでに通常編集の確定が済んでいる状態から、1回のコピーを実行する場合の回数。未確定編集を解消する既存の通信は両案に共通する。

| 比較項目 | A案・コピー時の Native 再取得 | B案・既存の確定済みsnapshotを再利用 |
| --- | --- | --- |
| 正確性・整合性 | 現 Native 値を得る。同期済みなら B と同じ正規化・省略のある設定。 `get_settings` は差分や同期異常時に Backend の revision を更新し得るため、コピー元の request revision と一致するか追加確認が要る | 最後に確認した Native 設定と適用 revision を一緒に取得。現 Document が同期済みで保留操作がないことを確認する。保存済みなら cursor／Recipe と照合済みの値。未初期化なら確定した Import／復元値を使える |
| Native 通信 | 追加の `develop.get` 1回 | 0回。Backend の現行 snapshot を読む |
| HTTP 通信 | コピー用応答を1往復。既存 `/settings` のままでは返却内容が不足 | コピー用応答を1往復。既存の応答に常時完全設定を載せれば0にできるが、転送量と同期責任が増える |
| 実装規模・再利用 | 既存 `get_settings` の通信・readback 処理を再利用。コピー応答の投影と owner 照合に加え、再照会後の revision 差分やエラーへの対応が必要 | 既存 `confirmed_settings` と現像 owner／保存ゲートを再利用。コピー応答の投影と owner 照合を追加。DB 直接方式も Native 0回で可能だが、追加の読込と現在設定との照合、Import 状態の取得元が必要 |
| 切替・Native 再生成 | Native 応答待ちの間に owner が切り替わり得る。完了済みのコピーは持ち越せる | 発行時と応答採用時の owner を確認。Backend 取得が Native 待ちに依存せず、完了済みのコピーは同様に持ち越せる |
| 追加状態 | コピー済みの値とリクエストの owner を管理 | 同じ。既存 Backend snapshot の再利用により新規キャッシュ、別同期、Frontend での全設定常駐は不要 |

**API 変更は必要。** 現行の `POST /documents/{handle}/settings` は Native 再照会の後に `controls_state` を返し、 `GET /recipe` と `GET /history` もコピー用の設定本文を返さない。四操作を既存の UI に接続する際は、選択 ID と期待 revision／fingerprint を受け、必要な部分 JSON だけを返す明示的な読み取り契約を追加する。既存の認証済み Document API 内の専用ルートまたは明示的なコピー取得分岐のどちらでも成立する。既存の表示用応答の拡張は不要。Backend の現行 Document 排他内で handle／workspace／generation／token、期待 Document revision／settings fingerprint、該当する Recipe revision、同期済み・保存保留なしを照合する。`confirmed_settings` 単体は永続確定や Frontend の未送信入力まで確認しないため、Frontend の確定境界と Backend の既存ガードの両方が必要。選択コピーはダイアログ確定時に1回取得する。 [現行のルーティング](../../../backend/windows_raw_api.py#L104-L130) · [現行 settings 応答](../../../backend/windows_raw_api.py#L832-L866) · [History 応答での既存再利用例](../../../backend/windows_raw_api.py#L1524-L1533)

今回の追加調査はソースと既存回帰ケースの確認。根拠となる回帰ケースには [切替と cursor 復元](../../../backend/tests/test_raw_history_api.py#L45)、[Undo／Redo／Jump と再訪](../../../backend/tests/test_raw_history_api.py#L664)、[保存の応答不明と再試行](../../../backend/tests/test_raw_history_api.py#L1078)、[Native 再生成と旧 owner の拒否](../../../backend/tests/test_raw_history_api.py#L1516)、[Undo 前の readback 不一致検出](../../../backend/tests/test_raw_history_api.py#L1816) がある。新しいコピー取得契約の動作検証は実装時の受入項目とする。

## N. P1-A 実装確定・選択コピー取得

**P1-A で本仕様を確定した。** E節で未確定としていた選択粒度は、依頼で指定された C 案の混合方式とする。M節の推奨どおり B 案、すなわち Backend の現行 Document が保持する確定済み `DevelopSettings` を使う。M.4 の「専用ルートまたは分岐を追加する」は、認証済み `POST /api/raw/documents/{handle}/copy-settings` の専用ルートとして実装した。既存 `/settings`・Recipe・History の応答契約は変えない。

### N.1 選択 ID と Native JSON fields

取得器は `backend/raw_edit_settings_copy.py` の閉じた `COPY_SETTING_IDS` と `extract_copy_settings()` に置く。選択 ID は History 表示 metadata ではなく、Native JSON への射影を指す。この表が P1-B の選択対象検証にも使う唯一の許可リスト。`all` という特別 ID は送らず、全コピーは `crop` 以外の全 ID を列挙する。

| 選択 ID | 粒度 | 取得する Native JSON fields |
| --- | --- | --- |
| `basic.exposure` | 個別 | `light.exposure` |
| `basic.contrast` | 個別 | `light.contrast` |
| `basic.highlights` | 個別 | `light.highlights` |
| `basic.shadows` | 個別 | `light.shadows` |
| `basic.whites` | 個別 | `light.whites` |
| `basic.blacks` | 個別 | `light.blacks` |
| `whiteBalance` | 一括 | `wb.mode`, `wb.scale`, `wb.temp`, `wb.tint` |
| `color.vibrance` | 個別 | `color.vibrance` |
| `color.saturation` | 個別 | `color.saturation` |
| `colorMixer` | 一括 | `mixer` の red/orange/yellow/green/aqua/blue/purple/magenta 各 hue/sat/lum |
| `pointColor` | 一括 | `point_colors` 配列 |
| `colorGrading` | 一括 | `grading` の shadows/midtones/highlights 各 hue/sat/lum、`blending`、`balance` |
| `pointCurve` | 一括 | `curve` の master/red/green/blue 点配列、highlights/lights/darks/shadows、split_shadows/split_mid/split_highlights、refine_saturation |
| `effects.texture` | 個別 | `effects.texture` |
| `effects.clarity` | 個別 | `effects.clarity` |
| `effects.dehaze` | 個別 | `effects.dehaze` |
| `vignette` | 一括 | `vignette.amount`, midpoint, feather, roundness, highlights, style |
| `sharpening` | 一括 | `detail.sharpen_amount`, sharpen_radius, sharpen_detail, sharpen_masking |
| `luminanceNoiseReduction` | 一括 | `detail.nr_luminance`, nr_detail |
| `colorNoiseReduction` | 一括 | `detail.nr_color`, nr_color_detail, nr_color_smoothness |
| `lensCorrection` | 一括 | optics の distortion, vignetting, vignetting_midpoint, profile_distortion, profile_vignetting, lens_profile |
| `chromaticAberration` | 一括 | optics の remove_ca, defringe_purple_amount/hue_lo/hue_hi, defringe_green_amount/hue_lo/hue_hi, ca_red, ca_blue |
| `localToneMapping` | 独立 | `profile.camera_local_tone` |
| `calibration` | 一括 | calibration の shadows_tint, red_hue/red_sat, green_hue/green_sat, blue_hue/blue_sat |
| `crop` | 一括・明示選択時のみ | `crop` と `orientation` |

この射影は公開中の Control 定義と geometry 契約を使う。Native の `disabled_sections`、`version`、`process`、WB以外の profile metadata、grading global、detail の未公開項目、grain、enhance、geometry 等の未公開機能、写真／カメラ／レンズ metadata は出力しない。個別設定として公開される optics の `lens_profile`、`remove_ca`、profile の `camera_local_tone` は値が false でも設定に含める。Crop は全コピー一覧から除外し、`crop` ID が選ばれた時だけ出力する。

### N.2 部分抽出・省略値

- 返却 JSON は選択された ID に対応する field だけを含める。入れ子 object、Point Color・カーブの array と順序、Native の数値精度を保ち、UI step／表示桁へ丸めない。
- コピー対象の既知の省略値だけを補完する。例: Point Color の省略は選択時に `point_colors: []`、`camera_local_tone` と optics flags の省略は false、Mixer は各色の hue/sat/lum を 0、Curve は現行の既知 serde defaults、Crop は既存 `DEFAULT_CROP` と orientation `Normal`。WB、Grading、Vignette、公開 numeric controls も各公開 field の既定値を用いる。
- `nr_outliers`、未公開 `nr_contrast`、WB以外の profile 情報等は本選択対象に含めない。選択外の配列は返さず、空 array は選択済みの空値として明示する。
- `complete_snapshot_for_merge()` は呼ばない。そこにある全復元用の補完を部分 payload に適用して、選択外設定を足すことを避ける。

### N.3 HTTP 契約と確定境界

`POST /api/raw/documents/{handle}/copy-settings` の JSON body は次の完全一致キーを受ける。

```json
{
  "workspaceId": "<current workspace>",
  "generation": 1,
  "documentToken": "<current document token>",
  "documentRevision": 4,
  "settingsFingerprint": "<64 lowercase hex>",
  "recipeRevision": 2,
  "selectedIds": ["basic.exposure", "pointColor"]
}
```

成功時は HTTP 200、`Cache-Control: no-store` で現在の owner identity、document revision／settings fingerprint、recipe revision、要求した選択 ID、射影後の `settings` を返す。既存の認証 middleware と Document owner 判定を通り、handle／workspace／generation／token、document revision、settings fingerprint、recipe revision が現在値と一致することを要求する。さらに既存 `_history_unsettled()`、Recipe save pending、recovery pending、Native `synced` 状態を検査し、History 初期化済みなら Recipe fingerprint と現在 settings fingerprint の一致を要求する。最終取得は `confirmed_settings(current_handle, current_revision)` が行い、active owner／generation／同期／revision／Native Interaction を再確認する。不正 ID・空選択は 400、古い owner／revision・保留状態は既存エラー契約の 409。旧 Document／Native generation や同期不能状態は既存 Document／Native error 契約に従う。

初回 Import の未初期化状態も、復旧 pending でなく Native が同期済みなら `confirmed_settings()` から取得できる。読み取り経路では `develop.get` を呼ばず、SQLite を読まず、Document／Recipe／History、Undo・Redo、Redo 分岐を変更しない。Ingress の通常 control reservation と `_lock` は既存の編集競合境界を共有する。コピー要求で確定できない Frontend の未送信スライダー値は対象にしない。UI 側が後続工程で既存確定処理を済ませてから要求する。

### N.4 検証と P1-B への引継ぎ

Backend `tests/test_raw_edit_settings_copy.py` は選択 ID・射影範囲、通常コピーでの Crop 除外／明示選択、公開外フィールド除外、省略 false／既定値、空配列、Point Color／Curve 配列、浮動小数精度、不正・重複・空選択、初回 Import と変更後の確定 snapshot、HTTP 認証、owner／revision、保存 pending、Native command 0件、SQLite/threadpool 読込 0件を検証する。同テスト 7件と既存 `test_raw_controls.py`・`test_raw_history_api.py` の計148件が成功した。既存 `POST /settings` 等の応答契約は変更していない。実際の `develop.merge`、適用後 readback、画素出力は対象外。

P1-B はこの `COPY_SETTING_IDS` と field 射影定義をペースト側の許可リストとして再利用する。ペーストは既存 History 操作の Native `develop.merge` 経路へ選択済み partial settings を渡し、LightCraft に適用・正規化を委ねる。貼付け後 readback／Recipe／History は従来境界を使う。コピー API から新しい完全設定 cache、SQLite snapshot reader、Native managed patch、設定変換エンジンを導入しない。

実装根拠: [選択ID・field mapping](../../../backend/raw_edit_settings_copy.py#L13-L49) · [部分抽出と既定値](../../../backend/raw_edit_settings_copy.py#L75-L183) · [Document API route](../../../backend/windows_raw_api.py#L117) · [owner／revision／保存状態と取得](../../../backend/windows_raw_api.py#L831-L869) · [`confirmed_settings`](../../../backend/lightcraft_raw.py#L1240-L1248) · [`_history_unsettled`](../../../backend/windows_raw_api.py#L1436-L1439) · [既存公開Control一覧](../../../backend/raw_controls.py#L9-L59) · [Curveの公開field集合](../../../backend/raw_controls.py#L59-L63) · [Crop／orientation契約](../../../backend/raw_geometry.py#L26-L52) · [P1-A回帰テスト](../../../backend/tests/test_raw_edit_settings_copy.py)

## O. P1-B 実装確定・History 経由の部分設定適用

P1-B は Backend の History 操作へ `settingsPaste` を追加した。コピーpayloadは一回の `develop.merge` に直接渡し、確定した Native readback を既存の History／Recipe 保存境界へ流す。既存Frontendの閉じたHistory応答parserが新stepを拒否することが分かったため、ユーザーの追加許可に基づきHistory step型・validatorとそのテストだけを追加した。Clipboard UI、選択ダイアログ、History専用表示、ショートカット、Desktop menu、Native managed patch／manifest／binary は変更しない。

### O.1 History 操作入力

既存の認証済み `POST /api/raw/documents/{handle}/history/operate` に次を渡す。既存の owner、generation、document token／revision、settings fingerprint、expected Recipe revision、save ID は通常操作と共通である。

```json
{
  "kind": "settingsPaste",
  "metadata": {
    "sourceAssetId": "<UUID>",
    "sourceFilename": "source.jpg",
    "selectedIds": ["basic.exposure", "whiteBalance"]
  },
  "copySettings": {
    "light": {"exposure": 0.25},
    "wb": {"mode": "custom", "scale": "kelvin", "temp": 5500.0, "tint": 3.0}
  }
}
```

`selectedIds` は P1-A の `COPY_SETTING_IDS`／`extract_copy_settings()` と同じ許可リスト・field 射影に照合し、空、重複、不明 ID を拒否する。`copySettings` は選択IDが生成する部分形と完全一致しなければならず、選択外Native field、欠落field、不正型、非有限値、過大payloadは 400 で拒否する。既存の Control、Curve、Point Color、Crop／geometry、WB scale／mode、Vignette style のvalidatorを再利用する。数値の表示桁丸めはしない。既知の省略既定値は P1-A 抽出器が選択済み部分に補った値をそのまま適用し、選択外の補完や `complete_snapshot_for_merge()` は行わない。false、0、空の Point Color 配列は値として扱う。Crop と orientation は `crop` ID が選択された時だけpayloadに含める。

`copySettings` の上限は64 KiB、表示metadataは1 KiB。表示metadataにはコピー元 Asset UUID、ファイル名、選択IDだけを保存する。部分設定本文は操作入力としてのみ使い、既存 History の確定snapshotを除いて重複保存しない。入力の要求本文上限は既存の4 KiBを他のHistory操作に維持したまま、settingsPasteだけに部分payloadの上限分を加える。

### O.2 Native・History／Recipe 境界

`LightCraftRawSession.apply_history_operation()` が確認済み `confirmed_settings()` を読み、選択部分がすでに一致するときはNative mutationなしでsnapshotを返す。それ以外は既存 `merge_settings()` → `_mutate()` の一回の `develop.merge` を使う。貼付け先全体のReset、`disabled_sections`、Process/schema version、選択外設定への明示変更はしない。LightCraftが適用・正規化し、readbackを確定値とする。Native通信の再試行・応答不明からの復旧は既存 `_mutate()` と History save ID／receipt契約に従う。

操作の確定snapshotと `settingsPaste` metadataは既存 `append_raw_history()` で一つのHistory項目として保存される。Undo／Redo／Jumpは従来のsnapshot復元経路を使う。無変更は既存History save境界でno-op receiptとして確定し、Historyを増やさずRedoを保持する。同じsave IDの再送は既存receipt／pending operationから応答し、mergeを重ねて行わない。保存失敗後の再試行・応答不明も同じpending／receipt経路を使用する。Historyのchanges表示値は選択された数値Controlに限定し、個別ON/OFFはflagChangesに載せる。

### O.3 検証結果

- `test_raw_edit_settings_copy.py` と `test_raw_edit_settings_paste.py`: **13 passed**。payload許可リスト・shape／範囲検証、通常コピーでのCrop除外・明示Crop、false／zero／空配列、選択外と`disabled_sections`保持、Native merge一回、readback、History一件、no-opとRedo維持、Undo／Redo／Jump、Recipe再訪、save ID再送、保存失敗／応答不明後の再試行、stale revisionを検証した。
- 関連Backend統合群は **551 passed**。一時SQLite作成を伴うrelease smoke assertion 1件はsandbox下で `unable to open database file` となったため、同じテストを通常権限で再実行して **1 passed** を確認した。空／重複選択ID拒否のケースを追加後、P1-Bテスト6件も再実行して **6 passed**。
- 実Native `test_raw_edit_settings_paste_live.py`: **5 passed**。JPEG→JPEG、Pentax DNG→JPEG、JPEG→Pentax DNG、Pixel DNG→JPEG、JPEG→Pixel DNGの各ケースでWB部分 `develop.merge` とreadbackを確認し、続く既存 `wb.temp` Control操作も成功した。
- Frontend `rawApi.test.ts` は `settingsPaste` History metadataを受け入れ、malformed metadataを拒否する検証を追加した。History rowは現状汎用の unknown operation 表示であり、コピー元名・対象項目を表示するUIはP1-Eに残す。

実Native検証の再現条件: `GENZOROOM_TEST_LIGHTCRAFT_EXE` に対象Native executableを設定する。RAW/DNGを使う場合は `GENZOROOM_TEST_RESET_PENTAX` に代表素材のpathを設定する。Nativeによるアルゴリズム再検証・画素比較は行っていない。

### O.4 P1-C開始時の引継ぎ（完了）

- History parser／型はP1-Bで `settingsPaste` とmetadata `{sourceAssetId, sourceFilename, selectedIds}` を受け入れる。P1-Cではこれを既存History operation APIへ接続し、History rowの表示UIは後続のP1-Dに残す。
- P1-CではP1-Aのcopy-settings応答をClipboardに保持し、貼付け開始時に既存Document ownerを再確認して `history/operate` を呼ぶ。History完了後は既存のsettings／history更新経路を使う。
- **WBの実Native検証は完了済み。** O.3の5ケース（JPEG→JPEG、Pentax DNG→JPEG、JPEG→Pentax DNG、Pixel DNG→JPEG、JPEG→Pixel DNG）すべてでWB部分merge/readbackの後に既存 `wb.temp` Control操作が成功した。RAW／JPEG間の値・色の画素等価性は検証対象外であり、GenzoRoom独自変換は行わない。

実装根拠: [P1-A許可リスト・payload validator](../../../backend/raw_edit_settings_copy.py#L13-L42) · [部分payload validation](../../../backend/raw_edit_settings_copy.py#L189-L350) · [History operation validation](../../../backend/raw_controls.py#L482-L492) · [`settingsPaste` merge/readback](../../../backend/lightcraft_raw.py#L2547-L2565) · [認証済みHistory request shape／validation](../../../backend/windows_raw_api.py#L1588-L1668) · [既存History操作からNativeへ渡す箇所](../../../backend/windows_raw_api.py#L1898-L1910) · [metadataを含むHistory保存](../../../backend/raw_recipe_store.py#L620-L675) · [Frontend History型・validator](../../../frontend/src/rawApi.ts#L156-L166) · [Backend paste regression tests](../../../backend/tests/test_raw_edit_settings_paste.py) · [実Native WB check](../../../backend/tests/test_raw_edit_settings_paste_live.py)

## P. P1-C: Frontend／Clipboard 接続

### P.1 実装仕様

- FrontendはLightCraftの完全設定を常駐保持せず、`POST /api/raw/documents/{handle}/copy-settings` の選択済み `settings` だけを、既存 `editClipboard.ts` の単一モジュールメモリslotへ独立snapshotとして格納する。payloadは `engine: "lightcraft"`、source Asset ID／filename、選択ID、部分設定を持つ。既存JPEG clipboardは `engine: "jpeg"` を明示し、JPEG側の既存コピー・貼付けをそのまま維持する。異なるengineのpayloadは相互適用しない。
- clipboardの存続期間は既存モジュールメモリと同じで、写真切替・現像画面の退出／再入場・owner／Native Session再生成をまたぐが、reload／アプリ終了では消える。copy結果、read、selected-paste用projectionはそれぞれcloneし、コピー後にsourceを再編集しても内容は変わらない。
- P1-Aの25選択IDは `rawApi.ts` の `RAW_COPY_SETTING_IDS` と型から公開し、通常コピー既定値は `crop` を除く24個とする。Frontend選択UI向けに `editClipboard.ts` はカテゴリ群と既存locale label keyをIDへ対応づける。BackendとのID完全一致は `backend/tests/test_raw_edit_settings_copy.py` からFrontend定義を読み、契約テストする。FrontendはNative settings inventoryを再定義せず、選択pasteで必要な部分projection pathだけを持つ。
- 選択pasteはコピー済み選択IDの部分集合に限定する。選ばれたIDに対応するJSON fieldのみを新しいobjectへcloneしてHistory本文に渡す。default補完・数値丸め・Native validatorの再実装は行わず、malformed／欠落値の拒否はP1-B Backend契約へ委譲する。配列フィールドは選択済みのJSON値全体をcloneするため置換として渡る。

### P.2 API契約と処理経路

- `readRawCopySettings()` は確定snapshotからowner identity（workspace／handle／asset／generation／document token）、revision、settings fingerprint、Recipe revision、selected IDsを送る。応答はこれらのechoと選択ID順序、plain settings object、payload sizeを厳密に検証する。 mismatchや失敗時は既存clipboardを更新しない。
- `useRawDocument.copySettings(filename, ids?)` は現行Document ownerをcaptureし、保留中の通常Controlを既存 `RawControls.settle()`／`RawRecipeSave` 境界で確定する。Mixer／Curve／Cropの一時interactionは各既存cancel経路、Point Colorは既存departure finish/cancel ownerに委ねる。確定後に一度だけcopy APIを呼び、応答後にowner、revision、fingerprint、Recipe revisionを照合してからClipboardを更新する。copyは専用保存を追加しないため、編集のない初回ImportではHistory initialize／保存行を作らない。確定済み状態の通信はcopy HTTP 1往復、追加Native取得0回、SQLite read 0回。
- `useRawDocument.pasteSettings(ids?)` は呼出時にClipboard snapshotと貼付け先ownerを固定する。通常pasteは全コピーID、selection pasteはコピー済みIDの部分集合だけを渡す。History未初期化の初回Importでpasteする場合は、既存 `RawRecipeSave` のinitialize境界を先に通してHistory operationを可能にする。続いて既存 `RawRecipeSave.operate()` に `{kind:"settingsPaste", metadata:{sourceAssetId,sourceFilename,selectedIds}, copySettings}` を渡し、既存save ID／retry／unknown outcome／recovery経路に載せる。
- `saveRawHistory()` は `settingsPaste` でのみ `copySettings` を既存 `history/operate` request top-levelに含める。既存のstep metadata validator／応答validatorを維持し、設定本文をmetadataへ重複させない。適用後のreadback、Preview、History更新は既存operation経路を使う。History metadataにJSON本文は入らない。
- P1-D向けにhookはcopy／paste関数、操作可否、engine一致、LightCraft copied IDsを公開する。今回メニュー、選択dialog、shortcut registry、Desktop menuは追加していない。

### P.3 検証結果

- Frontend `rawApi.test.ts`、`editClipboard.test.ts`、`AnshitsuClipboard.test.tsx`、`useRawDocument.test.tsx`: **593 passed**。選択ID／copy requestと応答identity、Crop除外／明示指定、全ID field projection、Clipboard clone／engine分離、旧owner応答拒否、初回copyでHistory save requestを増やさないこと、selection pasteの `settingsPaste` History本文／metadata、既存JPEG clipboardを検証。
- `backend/tests/test_raw_edit_settings_copy.py`: **8 passed**。Backend／Frontend 25 ID一致契約を含む。
- `npx tsc --noEmit` とFrontend production `npm run build`: 成功。Viteは既存chunk-size／React Router `use client` directive warningsを出力した。
- `git diff --check`: 成功。
- P1-B O.3に記録した実Native WB検証結果はO.4の古い記述を訂正済み。P1-CではNative現像演算や画素差は再検証していない。

### P.4 P1-Dへの引継ぎ（完了）

当時の引継ぎはR節のP1-D実装で完了した。コード上の選択UI・操作接続テストはR.4に記録する。ブラウザ／Desktop UI実動作と画素への貼付け反映はP1-Eの手動統合確認に残す。

## Q. P1-C-F1: WB補正方式の互換性制限

### Q.1 判定根拠

LightCraft v0.20.0 のNative `wb.scale` は `kelvin`（絶対Kelvin）と `legacy`（素材相対）を区別する。 GenzoRoomの `_settings_json()` はscale省略をNative既定値 `legacy` として正規化し、未知のscaleは受け付けない。Import時の `_Photo.import_settings_json` は `develop.get` のImport readbackをRecipe復元より先に保存し、その後のRecipe復元・WB操作・過去のcross-mode適用では更新しない。このため素材固有方式はImport readbackから決め、現在のHistory cursorまたはRecipe適用後の `settings.wb.scale` からは推定しない。 [v0.20.0 WB contract](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/docs/mcp.md) · [`_settings_json()` と `legacy` 既定値](../../../backend/lightcraft_raw.py#L393-L405) · [Import readbackの保存とRecipe復元順](../../../backend/lightcraft_raw.py#L1144-L1157) · [`controls_state()` の現在scale表示](../../../backend/raw_controls.py#L424-L433)

`photo.inspect.as_shot_wb` と `_Photo.wb_kelvin` はKelvin編集・As Shot reset能力を決めるための情報であり、素材方式の完全な区別には使わない。既存WB UIの `wb.scale` は現在設定に対するControl表示契約で、過去の部分設定適用後に素材固有方式を表さないことがある。素材方式はファイル拡張子、RAW/JPEG分類、カメラメーカー／機種からGenzoRoom側で再計算しない。 Native Import readbackでscaleを得られないケースは `unknown` とし、WB適用をfail-closedにする。

P1-Bで記録した実NativeのWB merge/readbackおよび後続Control成功は、Native APIがJSONを受理し編集を継続できた証拠である。絶対／相対方式間の意味的互換性を証明するものではなく、過去の検証結果はそのまま保持する。今回、実Nativeによる方式識別確認は環境変数 `GENZOROOM_TEST_LIGHTCRAFT_EXE` が未設定で実行できず、提供されたPentax／Pixel素材のある環境でもlive testはskipとなる。コード側では既存のLightCraft v0.20.0契約とImport readbackを根拠に方式を同定した。

### Q.2 確定仕様とAPI変更

- `sourceWbMode` は `absolute | relative | unknown`。BackendのOpen Document応答とP1-A `copy-settings` 応答に含める。値はImport readbackの `wb.scale` から導出する。Copy経路は既存 `confirmed_settings()` と保持済み `import_settings_json` のみを読み、Native再問い合わせとSQLite読込を追加しない。
- LightCraft Clipboardは `sourceWbMode` をコピー時点の不変metadataとして保持する。 `selectedIds` はWBを含んだままで、貼付け先の `clipboardPasteableSettingIds` で現在適用可能な項目を別に返す。WB不可のreason codeは `wbScaleMismatch` または `wbModeUnknown` とし、日本語・英語locale key `workspace.rawClipboard.wbModeMismatch`／`workspace.rawClipboard.wbModeUnknown` を用意する。これはP1-Dがdisabled理由を表示するためのinterfaceであり、今回UIは追加していない。
- **F1-01修正。** `editClipboard.ts` の共通 `lightcraftWbCompatibility()` が、コピー元source mode、payload `wb.scale` から読んだmode、貼り付け先source modeの3値を同時に判定する。hookの適用可能一覧と `pasteSettings()` の実適用がこの関数を共有するため、sourceとtargetだけが一致しpayload scaleが異なるケースでも表示とHistory payloadがずれない。非互換ならWBのみ射影から外し、他の選択項目は適用可能に残す。WBのみなら `canPasteSettings` をfalseにし、処理呼び出し時もHistory操作を作らない。Clipboard値は変更しない。
- 通常／選択ペーストは既存の選択projectionで適用可能IDだけを新規部分payloadへ抽出する。素材方式が不一致またはunknownならWB IDと `wb` JSONをpayloadから外し、他項目は同じ `settingsPaste` 操作へ適用する。WBだけが残って操作対象がなくなる場合はFrontendで `raw_wb_incompatible` とし、History操作／Native mutationを起こさない。Clipboardは変更しない。
- Backend `settingsPaste` ingressと `LightCraftRawSession.apply_history_operation()` の両方で、payloadのscale、コピー元 `sourceWbMode`、貼付け先のImport方式が一致しなければ `raw_wb_incompatible`（HTTP 409）で拒否する。拒否はHistory pending／Native mutationより前に行う。非WB項目には方式制限を適用しない。
- 新規 `settingsPaste` metadataに `sourceWbMode` を追加し、WB選択時は値と `copySettings.wb.scale` の一致を必須にする。履歴本文・Recipe保存metadataのvalidatorは旧 `{sourceAssetId,sourceFilename,selectedIds}` 形式も受け入れるため、既存Historyの復元・表示・Undo／Redo／Jumpは維持する。保存payload本文の二重記録はしない。
- P1-C `pasteSettings()` の `editor.confirmed` 取得直後に同一参照のrevisionを比較していた実効性のない条件を削除した。settle後は既存editor／saver ownerと変更されないDocument identityを検証し、revision・save境界は `RawRecipeSaver.operate()` に委ねる。独自revision状態は追加しない。

### Q.3 検証結果

| 項目 | 結果 |
| --- | --- |
| absolute→absolute／relative→relative | Backend契約テストで許可し、HistoryとNative mergeを確認 |
| absolute↔relative | Backend契約テストで409拒否、追加mergeなし、History length不変を確認 |
| 非WB項目を含む混合ペースト | 不一致時もFrontendがWBだけを除外し、他項目を `settingsPaste` に渡すことを確認 |
| WBのみ／Clipboard保持／別素材切替 | Hookテストで不一致先の操作無効、Clipboard保持、互換方式へ切替後の適用を確認 |
| Import方式と編集後のscale | HTTPテストで現在WB scale変更後もImport方式を返すことを確認 |
| 旧History metadata | 3項目metadataを含むHistory API／Store validatorの既存テストを維持 |
| 自動テスト | Backend copy／paste／History関連 **179 passed, 1 deselected**。`release_smoke_sqlite_assertions_against_current_database` はこの機能の変更対象外で、sandbox pytest temp環境のSQLite open失敗を確認したため除外。Frontend `rawApi.test.ts`／`editClipboard.test.ts`／`useRawDocument.test.tsx` はF1-01修正後 **468 passed**、既存 `AnshitsuClipboard.test.tsx` **129 passed**。回帰ケースは素材方式一致・payload scale不一致時のWB除外、非WB適用、WB-only無効、Clipboard保持、操作可否と適用内容の一致を確認 |
| 静的確認・build | `npx tsc --noEmit`、Frontend production `npm run build`、`git diff --check` 成功。buildは既存chunk sizeとReact Router `use client` warningを出力 |
| Live Native | `GENZOROOM_TEST_LIGHTCRAFT_EXE` 未設定のため `test_raw_edit_settings_paste_live.py` は実行条件を満たさずskip。RAW素材の場所のみではNative executableを起動できない |

### Q.4 P1-Dへの引継ぎ（完了）

当時の引継ぎはR節のP1-D実装で完了した。WB disabled理由は既存の `wbModeMismatch`／`wbModeUnknown` localeを使う。Nativeメニューバー接続は引き続きP2。

## R. P1-D: 選択ダイアログ・操作UI

### R.1 確定仕様

- 既存の `EditSettingsMenu` をViewer toolbar／Viewer context menuに共用し、`useRawDocument` の `copySettings()`／`pasteSettings()` に分岐接続した。コピー可能状態は `canCopySettings`、貼付け状態は同一エンジンかつ `canPasteSettings` を用いる。JPEG ClipboardとLightCraft Clipboardの間でpayload変換しない。
- 選択UIは `AdjustmentSelectionDialog` を共用する。任意カテゴリ・表示名・初期選択・disabled IDを受け取る拡張はLightCraft用のみ指定し、従来JPEGの項目構成、初期値、操作を維持する。LightCraftはP1-Cの25 ID、`RAW_COPY_SETTING_CATEGORIES`／`RAW_COPY_SETTING_LABEL_KEYS`を使用する。
- LightCraftの選択表示順は現像パネルに合わせ、Local Tone Mapping、Basic、WB／ColorとそのMixer・Point Color・Grading、Curve、Effects／Vignette、Detail、Calibration、Lens／CA、Cropとした。カテゴリ内の選択単位はID定義どおりで、一括対象のNative JSONをUIで分割しない。
- 選択コピーはCrop以外の `RAW_DEFAULT_COPY_SETTING_IDS` 24項目を初期選択し、Cropは「全選択」の明示操作でのみ含まれる。ダイアログ表示だけではAPIを呼ばず、確定時にのみコピー取得を開始する。CancelはClipboardに触れない。
- 選択ペーストはダイアログを開いた時点のLightCraft Clipboard snapshotとDocument owner identityを保持し、確定時に現行Clipboard全体・ownerが一致することを確認する。表示中のClipboardが入れ替わった場合は古い選択を適用しない。適用IDはClipboardに含まれるものに限定し、処理は既存 `pasteSettings(ids)` に委ねる。
- WBはUIで互換性を再計算しない。hookの `clipboardSettingIds`／`clipboardPasteableSettingIds`／`clipboardWbCompatibilityBlocked`／`clipboardWbCompatibilityReason`／`canPasteSettings`を使用する。互換性のないWBはコピー済み一覧に表示しつつdisabled・未選択とし、「全選択」でも有効化しない。理由は既存locale `workspace.rawClipboard.wbModeMismatch`／`wbModeUnknown`で表示する。他の項目はペースト可能なままにする。適用可能項目がない場合はメニュー操作を無効にする。
- ショートカットは `ImageViewer`／既存中央registryを使用する。通常Ctrl/Primary+C・VとCtrl/Primary+Alt+C・V、入力欄保護、dialog中の背景操作抑止を維持する。ペースト処理開始時は既存hookがClipboard／ownerを固定し、owner・保存状態を再検証する。
- Raw controlsにはJPEG版の設定コピー用slider/category context menuが存在しない。共有 `AdjustmentSlider` のcontext callbackはJPEG adjustment IDだけに対応している。既存LightCraft Point Color swatch menuは削除操作専用で設定コピーと意味が異なるため変更しなかった。新しいcontext menuは追加していない。Windows Native menubarはP2。
- `settingsPaste` History行は既存History rendererでコピー元ファイル名と実際に適用した `selectedIds` のラベルを日本語／英語で表示する。selectedIdsのない旧metadataは従来のコピー元名表示にfallbackする。

### R.2 実装範囲

Frontendのみ変更した。Backend API／Native managed patch／manifest／Native binary、Clipboard寿命・保存機構、History管理は変更していない。コピー取得／適用はP1-A／P1-BのHTTP・History操作境界を使い、既存LightCraft module-memory Clipboardを利用する。

### R.3 検証

| 項目 | 結果 |
| --- | --- |
| 選択ダイアログ・JPEG回帰 | `AdjustmentSelectionDialog.test.tsx` の既存JPEG仕様を含めて成功。RAW 24項目初期選択、Cropの明示選択、互換不可WBのdisabled表示・理由・Select All除外を追加確認 |
| Viewer menu／shortcut既存経路 | `EditSettingsMenu.test.ts`、`ImageViewer.test.tsx`、`AnshitsuClipboard.test.tsx` を含む関連5ファイル **291 passed**。LightCraft wiringは既存Viewer callbacksとraw hook interfaceへ接続 |
| History表示 | `RawEditHistory.test.tsx` で日英のコピー元・実適用項目表示、旧metadata fallbackを確認 |
| TypeScript／production build | `npm run build` 成功（`tsc --noEmit`を含む）。既存chunk-sizeとReact Router `use client` directive warningあり |
| diff整合性 | `git diff --check` 成功 |
| Desktop実操作 | 未実施。ユーザーの運用方針どおりP1-Eで確認 |

### R.4 P1-Eへの引継ぎ

- Windows DesktopでViewer menuの4操作、Ctrl+C／Ctrl+Alt+C／Ctrl+V／Ctrl+Alt+V、Crop明示選択、WB disabled表示と理由、写真切替後のowner拒否、Clipboard切替中のdialog拒否、History行を実操作で確認する。
- 代表JPEG／LightCraft素材間でエンジン不一致の拒否、同一LightCraftでの全／部分コピー・ペースト、適用後History・Undo／Redo／Jumpを統合確認する。画素演算の再検証は不要。
- LightCraft設定panelに対応する既存copy context menuはないため、コンテキスト操作の拡張は新しい要望がない限り行わない。Windows Native menubarはP2。

### R.5 P1-D-F1: 選択ダイアログ表示調整

- LightCraftの定義カテゴリが単一選択IDだけを持つ場合、カテゴリ名の親チェックボックスと同名の子チェックボックスを重複表示せず、設定名のチェックボックス1個で選択する。複数IDカテゴリは親子checkboxと中間選択状態を維持する。この判定はLightCraftカテゴリ設定時のみ有効で、既存JPEGダイアログには適用しない。ペースト時に複数IDカテゴリのうち1 IDだけがClipboardにある場合も、元カテゴリの複数選択単位を維持する。
- 単一選択IDカテゴリでのWB disabled状態と理由、通常copyの24 ID初期選択、Crop初期未選択、「全選択」によるCrop選択は維持する。
- 表示名は対象範囲に合わせて `pointCurve` を「ポイントカーブ全体」／“Point Curve (all channels)”、`vignette` を「周辺光量補正一式」／“Vignette correction settings”、`crop` を「切り抜き・水平補正」／“Crop and straighten” に変更した。これらの項目名は選択dialogで使用する。History表示の後続簡略化はR.6を参照。
- Frontend関連5テストファイル **293 passed**。単一カテゴリの直接checkbox、複数カテゴリの中間状態、24項目とCrop、WB disabled理由、Select All／Clear All、3名称の日英表示、History表示とJPEG回帰を確認した。`npx tsc --noEmit` と `git diff --check` も成功。
- P1-D-F1は表示構造・名称のみの変更。25 ID、selection scope、Clipboard／WB互換性、API、History保存契約、Backend／Native資材は変更していない。P1-E・P2の作業はこの変更に含めない。

### R.6 P1-D-F2: History・翻訳参照・列レイアウト

- `settingsPaste` のHistory説明は、全設定／選択ペースト、`selectedIds` の有無を問わず既存 `workspace.pasteHistory` のコピー元ファイル名＋操作名だけを使う。適用項目一覧は表示しない。metadataの `selectedIds` は保持され、保存形式に変更はない。不要になった `settingsPasteHistory` locale keyは日英から削除した。
- カテゴリと全25項目のlocale参照を日英locale実定義と照合した。未定義だったroot `workspace.*` のRAW panel用参照は、RAW現像パネルが使う `workspace.rawPreview.*` keyへ置き換えた。選択対象の表示名と現像パネル用語を共通化し、全translation keyについて日本語・英語それぞれ `i18n.t(key) !== key` をテストする。
- LightCraft選択dialogだけに `raw-adjustment-selection-dialog` classを付け、幅を最大1040pxへ拡張した。カテゴリ領域を均等高さのGrid行から、カテゴリを分割しない `column-count: 3` のbalanced flowに変更し、各カードは内容の高さを保つ。幅900px以下で2列、600px以下で1列へ縮退する。連続順序は現像panel順を保つ。JPEG dialogのclass・2列Grid・寸法は維持する。
- Frontend関連5テストファイル **293 passed**。日英のfull／partial Historyが同一の短い文になること、metadataのselectedIds保持、JPEG History回帰、25 IDとカテゴリの翻訳解決、LightCraft専用レイアウトclass、既存JPEGダイアログの分離を確認した。`npx tsc --noEmit` 成功。
- P1-D-F2はFrontend表示・locale参照・選択dialog layoutと研究文書のみ変更し、Clipboard、copy／paste処理、Backend API、History保存契約、Native資材は変更していない。実Desktopでの新レイアウト確認は未実施。P1-E／P2には着手していない。

## S. P1-E統合検証と現行仕様

検証対象はP1-A〜P1-D-F2を含む `7c66e854cecf1158a3e027421f86e00d4694ad9c`。N〜R節は各工程の記録で、以下に現行仕様と今回の結果を記す。

### S.1 現行仕様

- コピー取得APIはBackendの確定済みsnapshotを読み、追加Native通信とSQLite読み込みは0回。ペーストは選択対象の部分 `develop.merge` を行い、既存のHistory／Recipe保存とUndo／Redo経路を使う。Historyの表示は日英ともコピー元ファイル名を含むペースト操作名で、適用項目IDはmetadataに保持する。
- Clipboardは1タブ内のメモリに独立したコピーとして保持し、写真切替、Homeへの移動、Nativeセッション再生成をまたぐ。reload・タブ終了で消える。ペーストは同じエンジンのデータを受け付け、選択操作はDocument ownerと開始時のコピー内容を照合する。
- WBは素材固有のコピー元方式・コピー値のscale・ペースト先方式が同じ既知の方式の場合に適用できる。非互換WBは適用対象から外れ、選択画面では理由とともに無効表示する。設定が写真に合うかはユーザーが判断する。
- Viewerの4操作は全コピー、選択コピー、通常ペースト、選択ペースト。Windowsのショートカットは順にCtrl+C、Ctrl+Alt+C、Ctrl+V、Ctrl+Alt+V。対象は25項目で、切り抜き・水平補正は通常コピーから除外し、選択コピーでも初期未選択。単一項目カテゴリはチェックボックス1個で表示する。LightCraftのダイアログは最大1040px幅で、3列から画面幅に応じて2列・1列に切り替わる。

### S.2 ユーザーによるWindows Desktop確認

写真間の編集設定コピー＆ペースト、F2の3列レイアウトと翻訳表示、切り抜き・水平補正の初期未選択を確認済み。F2後の操作上の問題は報告されていない。個別のショートカット、狭幅時の列切替、WB非互換表示、owner変更時の操作やUndo／Redoなどは、今回受領した個別Desktop確認には含めない。

### S.3 P1-E回帰結果

| 区分 | 結果と対象 |
| --- | --- |
| Backend | **290件成功**。コピー取得・ペースト適用、WB拒否、部分merge、History API／Store、Recipe復元／API。 |
| Frontend | **11ファイル、831件成功**。コピー／ペーストのAPIとClipboard、owner境界、全体・部分選択とCrop、WB制限、History表示・保存、操作UI・日英翻訳、JPEG回帰。 |
| 静的確認 | `npm run build` 成功（`tsc --noEmit`を含む）。既存のバンドルサイズとReact Routerの `use client` 警告あり。`git diff --check` 成功。 |

### S.4 実Native WB確認

既存のmanaged LightCraft CLI v0.20.0をCPU設定で起動した。起動時のSHA-256は `2e04fea8da7d84018baf7384043656af482a23986a1c63361f8200923e77eef7`。Pentax DNG（IMGP5033.DNG）はImport時に絶対値（`kelvin`）、リポジトリのJPEG（Anshitsu_Sakura.jpg）は相対値（`legacy`）だった。

各素材のRecipeに逆方式のWBを含めて `restore_persisted_settings()` を実行した。Native readbackの現在scaleが反対の方式に切り替わった後も、Import時に保存した素材固有方式は両素材とも維持された。`apply_history_operation()` で逆方式のWBをペーストすると両方向とも `raw_wb_incompatible` になり、確定済み設定とrevisionは維持された。この確認は実Nativeを使ったアダプター境界の検証で、HTTP境界はS.3の回帰テストで確認した。

今回の検証範囲で新規Findingはなかった。画素比較、性能、Nativeメニューバーは今回の検証範囲外。

## T. P2 Windows Desktop Native Editメニュー

### T.1 実装仕様

- File／Edit／View／Helpの順に配置した。Editには「全設定をコピー／Copy all settings」「項目を選んでコピー…／Copy selected settings…」「コピー済み設定をペースト／Paste copied settings」「項目を選んでペースト…／Paste selected settings…」を配置する。Viewer menuと同じ文言・操作順で、Ctrl+C／Ctrl+Alt+C／Ctrl+V／Ctrl+Alt+Vを表示する。
- Native項目にはacceleratorを割り当てない。Windows Desktopの編集ショートカットは既存 `editShortcuts` registryとFrontend keydown処理が引き続き所有し、Native menu clickは `dispatch_main_event()` の4イベントから既存Viewer handlerへ接続する。これによりキーボード操作の二重発火と入力欄の通常copy/paste阻害を避ける。Native側に編集・Clipboard・Selection dialog・History処理は追加していない。
- AnshitsuPageは既存のエンジン別可否を使い、JPEGでは `clipboardEnabled`／Clipboard payload、LightCraftでは `rawClipboardBaseEnabled`／`sameEngineClipboard`／`canPasteSettings` を4項目の有効状態へ反映する。保存／復旧、写真切替・退出、Document未準備、Clipboard処理中、Settings／selection／History等のmodal/menu表示中は無効化する。DOMの既存modal/menu状態もMutationObserverで同期し、Anshitsu React state外の終了確認dialogを含める。変化のないDOM更新ではNative APIを再呼出ししない。Native click受信時にも現行ページ・state・dialog/menuを再確認して既存関数を呼ぶ。WB非互換の判定は既存hook結果を利用し、他項目が適用可能ならPasteを有効にする。
- 4項目はNative menu生成時に無効。Frontendから現在状態を同期し、暗室component unmount時とWebView `PageLoadEvent::Started` 時に全項目を無効化する。旧Frontend listenerがない画面ではイベントは処理されない。画面遷移、owner破棄、Frontend再読み込み後に古い有効状態を残さない。
- 既存 `set_native_menu_language` と `SettingsProvider` の初回言語同期／`languageChanged` subscriptionを拡張し、Edit名・4操作を日英で更新する。File／View／Helpは既存ラベルを維持。Dockerおよび共有Browser UIにはNative menuがない。
- Undo／Redoは今回追加・変更していない。暗室HistoryとSTACK／Export等のワンショットUndoの各owner・操作契約を調査した上で別案件として扱う。

### T.2 検証結果

| 項目 | 結果 |
| --- | --- |
| Frontendイベント接続 | `AnshitsuRawPreview.test.tsx` でLightCraftの有効状態、Native copyイベントから既存copy APIへの配送、modal表示時の無効化とmodal中の拒否を検証。JPEGでは4イベントを既存clipboard操作へ接続し、選択dialogの表示／取消し、同一snapshotを戻す既存no-opを確認。 |
| Frontend回帰 | `AnshitsuRawPreview.test.tsx`: **157 passed**（LightCraft／旧JPEGのNativeイベント接続、状態同期）。既存JPEG Clipboard／shortcutの `AnshitsuClipboard.test.tsx`: **129 passed**。件数は個別実行値で、P1-Eの831件には合算していない。 |
| TypeScript／本番build | `npm run build` 成功（`tsc --noEmit`を含む）。既存の大きなbundleとReact Router `use client`警告あり。 |
| Desktop Rust | `cargo test --locked --manifest-path desktop/Cargo.toml`: **20 passed**。Native menu日英ラベルと既存 lifecycle等を確認。`cargo check --locked --manifest-path desktop/Cargo.toml` 成功。 |
| 実Desktop menu | 未実施。Windows上で実際のmenu描画、クリック、実行中言語変更を操作する手動確認は今回行っていない。 |
| Docker／Browser | Docker build・Browser操作の動的確認は未実施。変更はDesktop bridge経由に限定し、共有BrowserにNative menu/event sourceを追加していない。 |

P1-EのBackend 290件・Frontend 831件・実Native WB確認はS節の工程別結果として維持し、本P2の成功件数へ合算していない。実Desktopの実操作、Windows menu shortcut hintの見た目・タブ整列、既存File／View／HelpのOS描画確認が残る。実装上の新規Findingは自動検証範囲では見つからなかった。

### T.3 P2-F1 IPC有効状態同期修正

ユーザーがWindows Desktopで暗室を表示しても4操作が無効のままになることを確認した。原因はTauri IPCのACL登録不足。`desktop/permissions/lifecycle.toml` の `allow-desktop-lifecycle` はMain WebView／localhostに限定されていたが、`set_native_edit_menu_state` を許可していなかった。加えて `desktop/build.rs` のapp manifest command listにもこのcommandがなく、Tauriの自動生成command permissionが作られていなかった。Frontendからのinvoke rejectionは捕捉して無視されていたため、permission denialが見えなかった。

手書きpermissionへ新commandを許可し、`build.rs` の限定command listへ `desktop_lifecycle`、`set_native_menu_language`、`set_native_edit_menu_state` を揃えた。Buildで生成される `allow-set-native-edit-menu-state`／`deny-set-native-edit-menu-state` command permissionも出力・検証する。CapabilityBuilderの `local(false)`、`window("main")`、`remote(http://127.0.0.1:{port}/*)` と既存 `allow-desktop-lifecycle` assignmentは変更していないため、許可対象origin／windowを広げていない。

FrontendはIPC失敗を無視せず、権限拒否・command未登録・その他invoke失敗を安全な固定 `errorCode` とcommand名・例外型で `desktop_menu.edit_state.sync_failed` warnへ記録する。raw error本文は記録しない。同じ失敗状態のDOM更新ごとに警告を重複させず、後続成功で再記録可能な状態へ戻す。メニュー状態は引き続きFrontendの既存操作可否に従い、無条件に有効化する処理はない。

| 検証 | 結果 |
| --- | --- |
| IPC permission境界 | Desktop Rust test **21 passed**。手書きMain UI permission、build.rs生成command permission、Tauri build出力の `acl-manifests.json` にあるコンパイル済み `allow-desktop-lifecycle` command listを照合。Tauri `invoke_handler`への登録もDesktop crate compileで確認。既存language commandを保持。 |
| 操作状態と失敗診断 | 関連Frontend **315 passed**（`AnshitsuRawPreview.test.tsx`、`AnshitsuClipboard.test.tsx`、`SettingsDialog.test.tsx`）。暗室入場時のcopy有効化、Clipboard後のpaste有効化、退出時の全無効化、permission rejection分類ログ、Nativeメニュー言語同期、既存JPEG／LightCraft操作を確認。 |
| Build／format | `cargo build --locked --manifest-path desktop/Cargo.toml`、Rust format check、Frontend `npm run build`（TypeScript含む）、`git diff --check` 成功。Frontend buildの大きなchunk／React Router directive警告は既存。 |
| 実Desktop | ユーザーは既存のキーボードショートカットが正常動作することを確認済み。これはNative menuのIPC経路とは別の確認。今回修正後のNative menu項目が実Tauri IPCを通過し、OS menu stateを変える実Desktop操作は未実施。 |

このFindingは権限境界の不整合として修正済み。Frontend mockのみではなく、Rust側のTauri command registration、build生成ACLと手書きcapability permissionの整合を検証した。実Desktopでの修正後確認はユーザー受入に残る。

### T.4 P2-F2 Native編集メニューのshortcut表記共通化

Native編集メニューにRust側で `Ctrl+C` 等を直書きしていた表記を廃止した。Frontendの `shortcutDisplay.ts` に4項目とShortcut IDの対応を集約し、各IDの表示は既存registry (`editShortcuts.ts` の `shortcutBindings`) と `formatShortcut()` から生成する。Windows／Linuxは `Ctrl`／`Alt`、Macは `⌘`／`⌥`となり、Viewerメニューと同じformatterを使う。

SettingsProviderの起動時同期および `languageChanged` 同期で、日英ラベルと4件のformatter出力を既存 `set_native_menu_language` IPCへ同時に渡す。従って初回起動およびWebView再読み込み後もFrontend初期化時にNative表示を再設定し、実行中の言語変更でもshortcut表示を維持する。Rustは受信した4文字列をラベルへ付加するだけで、キー割り当て・プラットフォーム判定・修飾キー表記の定義を持たない。Native menu itemのaccelerator引数は引き続き `None` で、キーイベントの所有者はFrontendである。IPC command、登録、ACLは既存の `set_native_menu_language` とP2-F1のMain WebView限定permissionを再利用し、command／permission追加はない。

| 検証 | 結果 |
| --- | --- |
| ID対応・プラットフォーム表記 | `shortcutDisplay.test.ts` で4 Native項目と `copySettings`／`copySelection`／`pasteSettings`／`pasteSelection` の対応を確認し、`formatShortcut()` 経由のWindows／Linux表記とMac表記を検証。実Mac実機は未確認。 |
| Viewer／一覧との一致・言語同期 | `shortcutHints.test.tsx` でViewerメニューの4表示がNative向け共通formatter出力と一致することを検証。`SettingsDialog.test.tsx` で初期言語設定時と日英切替時に同じformatter payloadがIPC bridgeへ送られることを検証。 |
| Native表示・accelerator | Desktop Rust **23件成功**。日英の基礎ラベル、Frontendから受け取るshortcut文字列の連結、camelCase IPC payloadのserde deserializationを検証。Native menu builderの4項目は明示的にaccelerator `None` を維持。P2-F1のcommand ACL／registrationに変更なし。 |
| 実Desktop | この変更後のWindows Native menu上の表示・言語切替は未実施。 |
