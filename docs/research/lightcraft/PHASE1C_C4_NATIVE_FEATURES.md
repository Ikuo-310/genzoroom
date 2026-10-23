# LightCraft v0.10.0 C4既存機能調査

調査基準：LightCraft v0.10.0、commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`。対象ソースは `I:\code\raw-test\lightcraft-v0.10.0-gpu-poc`。本書は既存実装のソース調査結果とGenzoRoom側で決定した設計方針を分けて記録する。ソース上の関数・行番号は上記固定commitを指す。新しいLightCraft版への更新、C4実装、テスト・build、実機GUI・GPUの再検証は行っていない。

証拠の表記は `パス::関数または型 (行)`。GenzoRoom側で既に実装済みと確認できた内容は本調査の対象外とし、MCPの機能有無とadapterの利用可否を区別する。

## 1. 総合結論（調査事実）

- Beforeの既定設定は編集開始時のスナップショットではなく、LightCraftの写真ごとの `import_defaults()`。RAWではAs Shot WB、初期シャープネス・色ノイズ低減、埋込レンズ補正等を考慮する。import presetによる `import_look` があればそれを使う。`Photo::import_defaults`／`camera_defaults` (`crates/catalog/src/model.rs:426-454`)、RAW defaults (`crates/develop/src/lib.rs:21-30`)、import defaults (`crates/engine/src/import.rs:341-369`)。
- LightCraftには実処理に作用するカテゴリbypassがある。`DevelopSettings.disabled_sections`に状態を保存し、OFF時は設定値を保持したままpipelineが該当処理を無効化する。MCPの汎用コマンド実行から設定・取得できる。`DevelopSettings::effective`／`section_enabled`／`set_section_enabled` (`crates/develop/src/lib.rs:104-146`)、`DevelopSettings` (`crates/develop/src/settings.rs:102-143`)。
- 写真単位のnative Historyはカタログに保存できるが、Session全体のUndo/Redo stackはSession内の一時状態。Session再生成でnative Undo/Redoは継続せず、新規import型Sessionでは写真Historyも再構成されない。DevelopSettings readbackだけでは元の履歴・cursorは戻らない。`Photo.history`／cursor (`crates/catalog/src/model.rs:218-259`)、library再open時のstack消去 (`crates/engine/src/library.rs:467-485`)。
- Before設定の選択コマンドは既存MCPで呼べる。既存headless画像取得はAfter固定であり、Before画素を直接返すにはMCP拡張が必要。比較表示レイアウトはGUI描画機能なのでGenzoRoomのImageViewerで行う。
- 全体Resetは写真・import defaultsを参照する。編集開始時baselineへの復元と同じ意味ではない。C4ではSQLiteに保存した履歴snapshotの復元と、LightCraft標準Resetを別操作として扱う。
- LightCraft内部実装、LightCraft MCPの公開API、GenzoRoom adapterが現在呼び出す機能は三層に区別する。LightCraft内部にあるだけでは既存MCPやadapterの利用可能性を意味しない。

## 2. Before/After（調査事実）

### Before設定の由来と寿命

`Session::before_settings()` は、Session内に明示的なBefore設定があればそれを用い、なければ写真の `import_defaults()` を用いる。両画像の整列のため、Before側へ現在のcropとorientationを適用する。`crates/engine/src/cmd/before.rs::before_settings` (17-20)。

Before設定の選択元は `import`、`current`、Historyのstep、version。`beforeAfter.setBefore`、`copyAfterToBefore`、`copyBeforeToAfter`、`swap`、`resetBefore` コマンドがある。設定選択はSessionの `before: HashMap<PhotoId, Arc<DevelopSettings>>` に保持され、カスタム値はSession終了・再生成を越えて永続化されない。Afterへのcopy／swapは `set_develop()` を通る編集である。`crates/engine/src/cmd/before.rs::set_before/before_to_after` (29-69, 72-106)、`crates/engine/src/lib.rs::Session.before` (342-344)。

既定の `import_defaults()` は `import_look` があればそれを使い、なければ写真のカメラ初期設定を返す。カメラ初期設定にはRAWのAs Shot WB、埋込レンズ補正が含まれる。RAW用 `for_raw()` はcapture sharpening 40、色ノイズ低減25を設定する。`crates/catalog/src/model.rs::Photo::import_defaults/camera_defaults` (426-454)、`crates/develop/src/lib.rs::DevelopSettings::for_raw` (21-30)。

注意：importではカメラ初期設定を作り、ユーザーのdefault presetを適用して `import_look` を保存する経路がある。一方、sidecar mergeやファイルごとのimport presetなど、import後に現在設定へ反映される変更の全てを `import_defaults()` がスナップショットとして保持するわけではない。従って「Before＝現像開始時に実際に適用済みだった完全なDevelopSettings」とは限らない。`crates/engine/src/import.rs::apply_import_defaults` (341-369)、写真へのsidecar適用 (`crates/engine/src/import.rs:1422-1425`)。

### 画像生成、GUI比較、キャッシュ

Engineの `render_job(id, w, h, before, apply_crop)` は `before=true` なら `before_settings()` からRenderJobを作る。ジョブkeyは設定hash・画像寸法・crop有無・写真ID・file content等から作られるため、Before基準や画像が変われば別結果になる。`crates/engine/src/media.rs::render_job/build_job` (1195-1198, 1207-1249)。

GUIは通常画像を `Slot::Main`、Beforeを `Slot::Before`、拡大領域を別slotで要求し、完了した画像を描画する。Side by side、wipe、上下・左右splitなどの配置・clip・分割線はGUI側の描画処理である。`crates/ui-egui/src/panels/detail.rs` (624-628, 705-780)、比較モードメニュー (`crates/ui-egui/src/menus.rs:87-90, 792-810`)。

GUI Rendererはslot単位で同じkeyの要求を省き、view slotごとのStageCacheを持つ。Before画像は別画像を保存したものではなく、同じRAW sourceをBefore設定でもう一度現像した結果。Beforeの通常render jobにサムネイル用の永続disk cache指定はない。`crates/ui-egui/src/render.rs::request_needed/request` (416-484)、`crates/engine/src/media.rs::build_job` (1242-1269)。

GPU/CPUの関係：Beforeも通常のRenderJob／現像pipelineに入り、GPU対応条件を満たしてGPUが使える場合はGPU、非対応・失敗時はCPUへ進む。GUIだけのGPU処理ではない。`crates/engine/src/media.rs::RenderJob::run` (958-1004)、`develop_reporting` (1024-1067)、GPU側のsection対応 (`crates/gpu/src/lib.rs:454-472`)。GPU有効性やGUI画素との一致は本調査では再測定していない。

### headless MCPでの画像取得

既存MCPの `render_preview` は `render_photo` を呼び、headlessの `ui.render` は `Headless::render()` から `Session::render_now()` を実行する。この経路は `render_now()` 内で `render_job(..., before=false, ...)` に固定されている。よって `beforeAfter.setBefore`をMCPから実行しても、既存 `render_preview` がBefore画像へ切り替わることはない。`crates/mcp/src/tools.rs::render_preview/render_photo` (502-524, 620-625)、`crates/mcp/src/headless.rs::render/call` (52-57, 142-151)、`crates/engine/src/media.rs::render_now` (1580-1585)。

最小のheadless拡張案（未実装）：`render_preview`／`render_photo`へ `before?: bool` を足し、MCP toolsからHeadlessへ引数を転送する。Headlessはtrueの場合、既存Engine API `render_job(id, size, size, true, true)`を実行して結果を返す。変更の中心は `crates/mcp/src/tools.rs` と `crates/mcp/src/headless.rs`。比較画像の合成・分割はGenzoRoom既存ImageViewerで行えば、MCP側へGUI比較UIを持ち込む必要はない。

## 3. カテゴリON/OFF（調査事実）

### UIと設定

LightCraft UIのsection headerの目アイコン操作は `develop.sectionEnabled` を実行する。パネルの開閉状態とは独立である。`crates/ui-egui/src/panels/edit.rs::section` (528-560)。設定はboolean群でなく `DevelopSettings.disabled_sections: Vec<String>`。OFF時はsection IDを追加し、ON時は除去するため、該当する各補正値自体は保持される。`crates/develop/src/settings.rs:142-143`、`crates/develop/src/lib.rs::section_enabled/set_section_enabled` (104-105, 141-146)。

GUIに目アイコンのあるsectionはLight、Color、Effects、Detail、Optics、Calibration。Engine／Settingsに加えてpipelineで対応があるsection IDは以下。個別UIのまとまりと、内部のbypass区分は必ずしも一致しない。

| ID | OFF時の現像影響（概略） | 主な根拠 |
|---|---|---|
| `light` | Light controlsおよびCurveを既定値扱い | `DevelopSettings::effective` (`crates/develop/src/lib.rs:112-121`) |
| `color` | WB、Color、Mixer、B&W mix、Grading、Point Colorを既定値扱い。Point Color配列を除去 | 同 (122-127) |
| `detail` | Detail controlsを既定値扱い。Denoise amountは0 | 同 (128-130, 134-138) |
| `effects` | Texture／Clarity／Dehaze、Vignette、Grain等を無効化 | `crates/pipeline/src/finish.rs:213-245` |
| `optics` | 対応レンズ処理／defringe等を無効化 | `crates/pipeline/src/optics.rs:76`、`crates/pipeline/src/lib.rs:235, 464` |
| `calibration` | Calibration matrix／Shadows Tintを無効化 | `crates/pipeline/src/finish.rs:225-230` |
| `geometry` | 対応Geometry処理を無効化（本件での詳細対象外） | `crates/pipeline/src/geometry.rs:316`、`upright.rs:590` |

### 値の保持、pipeline、History、MCP

OFFは表示だけではない。CPUの `pipeline::render_impl` とGPU renderer双方で `DevelopSettings::effective()` を使うか、個別処理が `section_enabled()` を参照し、OFF中の補正をbypassする。`crates/pipeline/src/lib.rs::render_impl` (538-543)、`crates/gpu/src/lib.rs::try_render` (461-469)。既存pipeline testはLight／Color／Detailの補正をOFFにした結果が既定画像と一致するケースを確認するテストを含む（テスト定義を確認したが、本調査では実行していない）。`crates/pipeline/src/tests.rs:333-356`。

`develop.sectionEnabled` は通常の編集共通経路 `edit()`→`Session::set_develop()` を通るため、カテゴリ切替はUndo可能な編集で、写真HistoryにもSettings全体を含む1 stepを追加する。`crates/engine/src/cmd/develop.rs::edit` (15-21)、コマンド (349-355)、`crates/engine/src/lib.rs::develop_op/set_develop` (931-938, 880-894)。設定JSONに `disabled_sections` が含まれるので、完全DevelopSettingsを保存・復元すればOFF状態と元値をともに再現できる。

MCP `command_run`／`run_command`から `develop.sectionEnabled` が呼べる。`get_develop`／`develop.get`は完全な設定JSONを返す。MCP機能の存在は確認できるが、GenzoRoomの公開adapterにこの機能が結線済みかどうかは別判定であり、既存adapter実装は本調査で追加検証していない。`crates/mcp/src/tools.rs:92-96, 585-587, 664-666`、`crates/engine/src/cmd/query.rs::develop.get` (170-181)。

OFFを有効にする汎用カテゴリIDとpipelineが実際に認識するIDを合わせる必要がある。LightCraftの任意field bypassではない。LightCraftにない「個別controlごとのON/OFF」は今回確認した機構に含まれない。

## 4. History・Undo/Redo・Interaction（調査事実）

### 写真HistoryとSession Undo/Redo

`Photo.history`は`HistoryStep { label, settings: Arc<DevelopSettings> }`の列。`Photo.history_cursor`は列のどのstepの設定が現在かを表し、`None`は最新step。履歴上限は200。これは写真単位の現像snapshotであり、初期設定からの差分ではなく完全DevelopSettingsを保持する。初期写真は空Historyで作られるため、最初の編集以前にimport defaultsのHistory stepが必ずあるわけではない。`crates/catalog/src/model.rs:218-259, 356-383`、`crates/catalog/src/lib.rs::HISTORY_LIMIT/PushHistory` (73, 728-745)。

通常のDevelop編集は、`SetDevelop`と`PushHistory`を一つのcatalog opにし、History labelと完全設定を追加する。cursorを過去へ戻してから新しい編集を行うとcursorより後を切り捨てる。History上限を超えれば古いstepを削除する。`crates/engine/src/lib.rs::develop_op` (931-938)、`crates/catalog/src/lib.rs::PushHistory` (728-745)。

一方、`Session.undo`／`redo`は各commitの逆 `Op` とlabelを持つstackであり、現像以外のcatalog操作も含む。Undo上限は1000件で、超過した古いUndo項目を捨てる。新しいcommitでRedoを破棄する。これはHistory列のcursorとは別に進む。`crates/engine/src/lib.rs::UndoEntry/Session` (133-145, 198-239)、`commit/undo_step/redo_step` (594-607, 731-778)。

`history.restore`は対象History settingsを現在へ適用し、cursorを移動する。元のHistory stepは残るので、新編集が来るまで後続stepも表示・選択可能。履歴分岐で後続を捨てるのはその次の編集時。`crates/engine/src/cmd/develop.rs::history.restore/go_to_history_step` (1096-1111, 1151-1163)、カタログ適用処理 (`crates/catalog/src/lib.rs:728-745`)。

### Interactionの動作

- `develop.beginInteraction`：以前のinteractionがあれば確定し、active写真IDと開始時DevelopSettingsを保存する。
- 操作中に`develop.set`／`develop.merge`：設定を画面用に更新するがUndo／History commitは行わない。
- `develop.endInteraction`：変化があれば開始時の値を一旦silent restoreし、最終値を1 undo／History stepにする。変化がなければ何も追加しない。
- `develop.cancelInteraction`：開始時設定へsilent restoreし、変更stepを追加しない。

実装：`crates/engine/src/lib.rs::begin_interaction/end_interaction/cancel_interaction` (941-967)、`set_develop` (880-894)、commands (`crates/engine/src/cmd/develop.rs:1135-1147`)。GUI sliderはdrag startでbegin、drag update中に変更、drag stopでendする（`crates/ui-egui/src/panels/edit.rs:19-36`）。

MCP helper `set_develop`にphoto `id`を毎回渡すと、`tools.rs::activate()`は毎回`library.select`を発行する (`crates/mcp/src/tools.rs:432-437`)。LightCraftの`library.select`は同じ写真を再選択しても現在interactionを終える (`crates/engine/src/cmd/library.rs:619-635`)。従ってdragを1 stepへまとめるには、開始前に写真を選択し、interaction中はid付きhelperによる再選択を繰り返さずactive写真へ値を送り、終了時にendする。`develop.set`の`ids`配列経路は各写真の設定を直接作ってcommitするためinteractionのactive写真経路とは異なる (`crates/engine/src/cmd/develop.rs:202-215`)。

### 永続化・Session再生成・MCP

写真History／cursorはPhoto/Catalogに含まれ、LightCraftの永続Library journal／snapshotを利用すれば保存・再openできる。cursorを永続journalから復元するテスト定義もある（実行はしていない）。`crates/engine/src/library.rs:613-642, 682-706`、`crates/engine/src/tests_history_cursor.rs:80-100`。

Session Undo/RedoはCatalogの永続データではない。`open_library_in()`はCatalog読込後にUndo・Redoをclearする (`crates/engine/src/library.rs:467-485`)。GenzoRoomの現在のMCP Session再生成方式でDevelopSettingsだけをSQLiteからrestoreしても、**LightCraft native Historyは元通りに継続できない**。新Sessionが既存Libraryそのものを開く方式なら写真History/cursorは残り得るが、それでもUndo/Redoは消える。GenzoRoomの現在のRAW recipe restoreは履歴全stepのexport/importではないため、Session再生成を跨ぐnative History継続を実現しない。

MCP command APIには`history.list`、`history.restore/previous/next/clear`、`edit.undo/redo`、3つのinteraction commandがある。`history.list`はlabel一覧・cursor・version metadataを返すだけで、各stepの完全設定・History全体の一括serialize/restore APIではない。`crates/engine/src/cmd/query.rs:217-224`、`crates/engine/src/cmd/develop.rs:1053-1147`、MCP汎用command call (`crates/mcp/src/tools.rs:92-105, 585-587`)。

## 5. Reset（調査事実）

| Engineコマンド | 動作 | History／Undo |
|---|---|---|
| `develop.resetControl` | `ControlSpec.default`を指定controlへ設定する。写真固有初期値との比較ではない | 編集として記録 |
| `develop.resetSection` | Sectionに所属するcontrolsを既定値へ戻す。一部追加処理あり | `Reset <section>` 編集として記録 |
| `develop.reset` | `import_look`があればそれへ戻す。なければ写真のcamera defaultsを基礎にAs Shot WBをsource infoから設定・正規化。最後にprocessを現行へ更新 | `Reset`編集として記録 |

根拠：`crates/engine/src/cmd/develop.rs::edit/develop.reset/resetSection/resetControl` (15-21, 256-290, 324-347)、`crates/catalog/src/model.rs::import_defaults/camera_defaults` (429-454)、`crates/develop/src/lib.rs::reset_section` (148-162)。

Section ResetはOFF状態をONへ戻す処理ではない。OFF中の補正値を既定値に変更する操作とbypass toggleは別である。またSection ResetのSection単位はbypassのまとまりと厳密には一致しない。例えばLight OFFはCurveも無効化するがLight Resetは別SectionのCurveを一括resetしない。Effects ResetもVignette／Grainを別途扱う。`crates/develop/src/lib.rs:112-130, 148-162`。

GUI全体Resetは存在し、`develop.reset`を呼ぶ。固定commitの編集panelでは`develop.resetSection`へ接続するカテゴリReset UIは確認できなかった。Engineコマンドの存在を同commit GUIの操作存在と混同しない。`crates/ui-egui/src/panels/edit.rs:424-428`。

**標準ResetとGenzoRoom編集開始baseline復元は異なる。** LightCraft標準Resetは写真固有のcamera/import lookを使い、processも現行化する。GenzoRoomで「このRAW documentを編集開始した時点へ戻す」には、GenzoRoomが保持したbaseline DevelopSettingsを適用してreadback確認する必要がある。両方をUI上でも識別する。

MCPの`command_run`で全コマンドを実行できるため、上記3 Reset commandはいずれも既存MCPから利用可能。adapterでの露出状況は別途確認事項。

## 6. headless MCP対応表（調査事実）

「既存MCP」はLightCraft MCP command surface。「GenzoRoom adapter」はPhase 1B/1Cで実装した内部Python APIがその機能を実際に公開・利用しているかを指す。今回確認したadapterの既存操作は、ユーザー提示と既存設計書にあるimport、DevelopSettings readback／change／restore、1024px Preview等の範囲に限る。

| 機能 | GUI内部実装 | 既存MCPで利用可能 | MCP拡張が必要 | GenzoRoom側で実現可能 |
|---|---|---|---|---|
| Before設定選択 | Engine command＋Session-local state | `beforeAfter.setBefore`等を汎用command経由で可能 | 既存Engine commandは不要 | 可能。現在のadapterへ呼出し追加は未確認 |
| Before画像 | 別設定のBefore RenderJob | 直接取得は不可。`render_preview`はAfter固定 | 画像renderにBefore引数を足す小拡張が必要 | 取得後PNGを扱える。基準設定選択・永続管理はC4仕様による |
| 比較表示 | GUIで描画slotを配置・split/wipe合成 | headless MCP UIでは提供なし | GenzoRoomで表示するならLightCraft UI拡張不要 | 既存ImageViewerで可能 |
| カテゴリON/OFF | `disabled_sections`をpipelineでbypass | `develop.sectionEnabled`／`develop.get`を利用可能 | LightCraft MCP拡張不要 | 可能。adapterへの専用結線有無は未確認 |
| History取得 | History panel／`Photo.history` | `history.list`はlabel・cursorまで。全snapshot直接取得なし | 完全履歴読出し・一括restore APIには拡張が必要 | SQLite snapshot方式で実現可能 |
| Undo/Redo | Session stack | `edit.undo`／`edit.redo`を実行可能。stackはSession寿命限定 | Session内native操作には不要。永続跨ぎnative履歴には不足 | SQLite snapshot適用・readbackで可能 |
| Interaction | begin/end/cancel、GUI sliderが利用 | 全3 commandを利用可能 | 既存MCPに追加不要 | 可能。ただし連続id指定helperは再選択に注意 |
| Control／Section／全体Reset | GUI全体Reset、Engine各command | 汎用commandで3 commandを利用可能 | 既存コマンド呼出しは不要 | 標準ResetとGenzoRoom baseline復元の両方を実現可能 |

LightCraft MCP helperの一般画像toolは`tools.rs::render_preview`→`render_photo`→`ui.render`→`Headless::render`で実装される (`crates/mcp/src/tools.rs:502-524, 620-625`; `crates/mcp/src/headless.rs:52-57, 142-151`)。`command_run`は任意の登録済みEngine commandを転送する (`crates/mcp/src/tools.rs:92-105, 585-587`)。MCPで呼べることとGenzoRoom側adapterが任意commandを外部へ公開することは同義ではない。GenzoRoom設計書ではFrontendへ任意MCP commandを公開しない制約がある (`PHASE1C_DESIGN.md §2, §7`)。

## 7. GenzoRoom C4への推奨（設計提案）

### 案Aと案B

| 観点 | A：LightCraft native中心 | B：GenzoRoom側管理 |
|---|---|---|
| 実装規模 | Session内の機能呼出しは小さい。履歴の全snapshot入出力・世代越し保持にAPI拡張が必要 | SQLite履歴／cursor・readback restoreを追加する必要がある |
| 既存headless API変更 | Before画像と履歴全体を永続扱いするなら拡張が必要 | 完全readback／restoreを利用し、native History APIへの依存を避ける |
| Session自動再生成 | Session Undo/Redoは消去。新import Sessionのnative Historyも再現されない | 保存済みDevelopSettings snapshotから復元可能 |
| アプリ終了後 | 永続LightCraft Libraryなら写真Historyは保存可能だが、Undo stackは再開しない。現在のMCP履歴入出力は不十分 | SQLiteを保存先にすれば終了・再生成後もcursorとsnapshotを維持できる |
| GPU Preview | 通常のLightCraft render path | restore後に同じLightCraft render pathを使える |
| RAW recipe DB | native catalogとGenzoRoom SQLiteの二重正本になり、同期・再生成の扱いが増える | 現在のSQLite RAW recipeを拡張する。一時的なrecipe fingerprint/revisionと履歴cursorは区別する |
| LightCraft更新保守 | native Historyの内部形式・stack意味への結合が強い | DevelopSettings snapshot schema/version検証を継続。履歴制御はGenzoRoom側に固定 |

### 機能ごとの推奨（提案）

1. **RAW履歴、undo/redo：案B。** GenzoRoom SQLiteを正本とし、完全DevelopSettingsを各履歴snapshotとして扱う。Undo/Redoはtarget snapshotをLightCraftへ適用し、readback一致を確認した後でcursorを移す。native Undo/Redo stackとGenzoRoom cursorを混在させない。既存のSettings identity／engine互換性確認、saveId・revision規約を活用し、cursorのDB更新も失敗時整合性を設計する。
2. **カテゴリON/OFF：案Aを利用して案Bへ保存。** RAWに対して`disabled_sections`をLightCraftへ設定する。readbackされた完全DevelopSettings snapshotに含めて履歴へ保存する。LightCraft bypassで補正値を保持できるため、GenzoRoomで数値をゼロ化・退避する独自カテゴリ実装は要らない。JPEGのカテゴリON/OFFは現行を維持する。
3. **個別ON/OFF：削除方針。** RAWに個別slider ON/OFFは追加しない。JPEGの個別slider ON/OFFも廃止する。個別Resetは維持する。Recipe形式／SQLite schemaの破壊的変更は開発段階として許容し、実際のmigration／既存データ影響はC4設計で決める。カテゴリON/OFFはJPEG・RAWとも維持する。
4. **Before/After：GenzoRoomで基準と表示を管理し、native render機構を利用する方向。** 比較表示は既存ImageViewerを用いる。Before画像の直接取得に必要なheadless MCP拡張を別工程で判断する。Before基準（import defaults／GenzoRoom編集開始snapshot／任意History snapshot）はC4設計で確定する。GUI画面の合成処理を流用前提にしない。
5. **Interaction：native begin/end/cancelを補助的に利用可能。** ただし写真の再選択でinteractionが終わらないようadapter呼出しを整理する。GenzoRoomの履歴step確定とSQLite save ackの境界を別途定義する。
6. **Reset：2種類を提供する設計。** LightCraft標準Resetを利用する場合は、そのcamera/import defaults基準を明示しreadbackする。GenzoRoomの「編集開始状態に戻す」はSQLite baseline snapshotの適用・readbackで行う。名称・undo記録を区別する。

## 8. GenzoRoom側の設計方針（決定事項）

以下は今回の依頼で指定されたGenzoRoom側の決定であり、LightCraftソースから導いた事実ではない。

### 個別ON/OFF

- RAWの個別スライダーON/OFFは実装しない。
- JPEGの個別スライダーON/OFFは廃止する。
- 個別Resetは維持する。
- カテゴリON/OFFはJPEG・RAWとも維持する。
- RAWカテゴリON/OFFの現像処理にはLightCraft native `disabled_sections`を使う。
- GenzoRoomは開発段階のためRecipe形式・SQLite schemaの破壊的変更を許容する。旧形式互換を必須としない。実際の変更方法と既存データ影響はC4設計で決める。

### RAW History

- GenzoRoom SQLiteをHistoryの正本とする。
- 履歴snapshotは完全DevelopSettings。
- Undo/Redoは対象snapshot適用とreadback確認を基礎にする。
- LightCraft native Undo/RedoとGenzoRoom履歴cursorを混在させない。

### Before/After

- LightCraftの既存Before rendering機構を活用する方向で検討する。
- Before画像取得に必要なheadless MCP拡張は別工程で判断する。
- 比較表示はGenzoRoom既存ImageViewerを活用する。
- Beforeの基準設定はC4設計時に決める。

## 9. 将来のRAW編集候補（範囲外）

ユーザー提示のLightCraft Windows画面から読み取れる将来候補を記録する。**画面上で確認した項目の控えであり、headless MCPでの利用可否、対応RAW、現像結果、実機動作は検証していない。C4実装対象へ追加しない。**

- WBのAs Shot／Auto／各種プリセット。
- カーブ、カラーミキサー、ポイントカラー、カラーグレーディング。
- 効果、シャープネス、ノイズ軽減、レンズ補正、キャリブレーション。
- クロップ・ジオメトリ。
- マスク：Object、説明による選択、Subject、Sky、Background、Brush、Linear Gradient、Radial Gradient、Luminance Range、Color Range。
- SAM 3等のAIモデル連携。

項目の存在表示と、本調査で確認したEngine／MCP APIの利用可否を混同しない。これらは将来の独立スコープで機能・adapter境界を調査する。

## 10. 未確認事項・追加検証

- GenzoRoom現在のadapterがBefore選択、section toggle、History、Reset、interaction commandを内部APIとして公開しているかは本調査ではコード確認していない。MCP commandがあることだけでadapter対応済みとは判断しない。
- Before基準の仕様：LightCraft `import_defaults()`、GenzoRoomの編集開始readback、過去履歴stepのどれにするか。
- MCPへBefore画像flagを追加する場合のresponse bytes／preview連打時の性能・stale応答制御。
- native `history.list`で返さない全Settings snapshotをどう扱うか、写真History 200件とGenzoRoom履歴保持件数・DB容量の契約。
- Interactionを使う時のMCP helperのphoto再選択回避と、cancel／通信切断／Session再生成時のrollback挙動。
- LightCraft標準Reset、GenzoRoom baseline restoreのUI上の名称・履歴上の位置付け。
- Windows GUI／MCPの再実行、CPU/GPU画像一致、実機Viewer確認は未実施。本書の根拠は固定commitのsource readと、既存の調査・PoC文書。
- 将来候補一覧の各項目をheadless commandから利用できるか、GenzoRoom recipe policyに合うかは未調査。

本書作成では文書以外を変更せず、テスト・buildを行わない。差分の空白検査には `git diff --check` を使う。

## C4-D実装補記（2026-10-23）

上記は未変更の本家固定commitを読んだ時点の調査記録として保持する。C4-Dでは同じv0.10.0／`a2a41383c4fd62fa85a46ccd00998639221f2d3c`に対し、GenzoRoom管理の[`0001-native-before.patch`](../../../native/lightcraft/patches/0001-native-before.patch)だけを追加した。v0.12.0以降へ更新していない。現在の実装仕様・受入結果は[Phase 1C設計のC4-D完了記録](PHASE1C_DESIGN.md)と[更新ガイド](UPDATE_GUIDE.md)を優先する。

- `render_preview`のschemaにoptional boolean `before`（省略時false）を追加。`render_photo`が`ui.render`へ伝達し、headlessのBefore分岐は既存native `render_job(..., true, true)`を実行する。Afterの`render_now()`を変更しない。
- 応答metadataに実画像の`kind`を追加。Beforeはnative import defaultsのhash64、crop／orientation適用後のsettings hash64、実際のgeometryを返す。Beforeを要求したのにbackendがkindを証明しない応答はMCP側でも拒否する。既存PNG／PhotoId／寸法metadataを維持する。
- headlessの`beforeAfter.setBefore {source:"import"}`応答へnative import fingerprintを付加する。GenzoRoomはimportごとに基準を明示し、History／Recipe／ResetからBeforeを擬似生成しない。native Beforeの既存import WB・crop／orientation処理をそのまま利用する。
- Rust fixtureはAfterの露光量・手動歪曲と独立したimport Before、crop／orientationの一致、WB、実画像寸法、read-only性とAfter省略呼出しを確認する。MCP関連55件成功、既存shutdown補助1件ignore。CLI release buildとsynthetic PNGによる実binaryのschema／Before／After probeにも成功した。実RAW／GPU／WebView画像比較の成功を意味しない。
- patchの対象commit／目的／変更対象／SHA-256をmanifestに記録する。未変更固定sourceへの再適用と二重適用拒否を確認し、build後の実binaryもdigest receiptとschema／kindで検証する。上流更新・同等機能の取り込み後にpatchを外す手順をUPDATE_GUIDEへ記録し、ルートAGENTS.mdから必須化する。
