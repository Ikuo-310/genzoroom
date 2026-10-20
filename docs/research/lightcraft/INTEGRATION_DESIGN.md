# LightCraft 統合候補と最小PoC案

収録日：2026-10-20。基準：LightCraft v0.9.1 / `4f0b110bcbd2e350c6d97b47f1d824c2222295c4`。
元資料と証拠区分は[資料索引](README.md)を参照。以下の元資料由来の節番号・ソース行番号は元調査のものを維持している。

本書は設計提案。比較の難度・応答性は実測ではなく、GenzoRoom側との実接続・コード適合調査は元資料で行っていない。既存LightCraft APIの制約と、Adapterで追加する責任を区別する。現行のRecipe・History・永続化への採用を確定したものではない。

## Windows版を当面の統合対象とする経緯（2026-10-20）

### 運用条件（ユーザー提供情報）

運用中のQNAP TS-664はオンボード8GBメモリの増設不可モデルであり、Immich、GenzoRoomなどの既存サービスを常時稼働させている。

### QNAPのメモリ調査結果（ユーザー提供の過去の実測）

以下はユーザーから提供された、当時のメモリ調査のスナップショットである。測定日時・採取コマンド・生ログは今回提示されておらず、本資料の収録時点で再測定した値でも、現在の状態を示す値でもない。

| 項目 | 当時の値 |
|---|---:|
| OS認識物理メモリ | 約7.55 GiB |
| MemAvailable | 約580 MiB |
| 回収困難なSlab | 約1.89 GiB |
| 使用中Swap | 約8.2 GiB |
| ZFS関連Slabの主要3項目 | 約869 MiB |

これらは異なるメモリ指標であり、合算して総使用量や不足量を算出しない。

### 既存の実測結果

Windows Docker Desktop上のLinuxコンテナでは、LightCraft単独のCPU現像に成功している。最大RSSはPixel RAWで1,089,004 KiB（約1.04 GiB）、Pentax RAWで1,675,444 KiB（約1.60 GiB）。検証条件と実測値は[PoC結果](POC_RESULTS.md#v091-linux-docker-cpu-poc)を参照。これらはLightCraftの単独現像プロセスの測定値であり、QNAP上の測定値やNAS全体のメモリ使用量ではない。QNAP実機ではLightCraftを実行していない。

### 運用判断と当面の方針

メモリを増設できず、当時すでにSwap使用量も大きかったことから、LightCraftの追加稼働による既存サービスとのリソース競合が懸念された。この運用条件と既存の単独現像実測を踏まえ、現行NAS環境でのRAW現像常用は厳しいと判断し、Windowsネイティブ版GenzoRoomを開発してLightCraftを統合する方針へ変更した。これは運用上の方針判断であり、常駐MCPなどの具体的な接続方式を正式採用したという意味ではない。

QNAP上でのLightCraft現像は実測しておらず、技術的に実行不能と断定するものではない。別環境で測定したLightCraftの最大RSSと、当時のQNAPのMemAvailableを単純比較して実行可否を決めたものでもない。

## 6. 統合方式の比較

以下の難度・応答性は設計上の判断であり、今回のベンチマーク結果ではない。

| 方式 | Python Backendからの難度 | 応答性 | メモリ管理・障害分離 | upstream追随 |
|---|---|---|---|---|
| CLI `render`を毎回起動 | 低 | 起動・読込・現像を毎回行うため対話編集には不利 | 終了時に解放。プロセス分離 | バイナリ差替え中心 |
| CLI `mcp`を常駐 | 低〜中 | ソース再利用可。ただし同期処理、段階キャッシュなし、一時画像・Base64の負担 | Sessionが保持。Pythonから細かなキャッシュ制御は限定的 | 既存プロトコルを使えるため比較的容易 |
| Engineを包む専用Rustプロセス | 中 | `StageCache`、Draft、最新要求への集約を利用可能 | Adapterで予算・寿命管理。Pythonと分離 | 公開Rust APIへの追随・再ビルドが必要 |
| Rustライブラリを直接組込み | Tauri Rust側は中、Python拡張は高 | IPCを減らせるが応答性の実測は未確認 | ホストとメモリ・障害を共有。FFI所有権管理も必要 | Rust APIとホストの両方へ追随 |

### 6.1 既存CLIを子プロセスにする方式

単発`render`は実装が最も簡単だが、対話編集で再デコードなどの費用を繰り返す。常駐MCPなら同一Sessionのソースキャッシュを使えるため、最小PoCに向く。

Python側にはプロセス寿命、MCP初期化、stdoutのJSON応答、stderrのログ、要求ID、画像content、エラー、終了・再起動の管理が必要。MCPへ大量のPreview要求を送ると順番待ちになるため、呼出側で最新要求に集約する。

### 6.2 専用Rustプロセス

Engineの既存公開APIを利用し、GenzoRoom専用の薄いIPCを提供する方式。GUIクレートのRendererをそのまま取り込まなくても、`RenderJob`、`StageCache`、request ID、結果受入れAPIを利用できる。

実装対象はセッション所有、要求管理、ジョブ実行、画像エンコードとIPC、メモリ予算、終了処理。現像アルゴリズムの再実装は不要である。単一表示slotに対して実行中1件＋最新待機1件などの制御を採れる。

### 6.3 直接ライブラリ利用

TauriのRust側にEngineを組み込む経路と、Python拡張経由で組み込む経路は分けて評価する必要がある。

EngineはRustライブラリとして公開されているが、調査対象には既成のPython binding、C ABI、`cdylib`構成は確認できなかった。Pythonの`ctypes`からそのまま呼べる状態ではない。Python拡張にする場合はbindingとビルド・配布・所有権管理が別途必要。

Tauri側へ直接組み込む場合も、Python Backendとの責任分担と通信経路を再設計する必要がある。GenzoRoom側コードを確認していないため、具体的な変更量は未確認。

根拠：[crates/engine/Cargo.toml](/I:/code/lightcraft/crates/engine/Cargo.toml)、[crates/pipeline/Cargo.toml](/I:/code/lightcraft/crates/pipeline/Cargo.toml)、[crates/develop/Cargo.toml](/I:/code/lightcraft/crates/develop/Cargo.toml)。

### 6.4 推奨順序とupstream追随

1. 接続・画質・必要操作のPoC：常駐MCP。
2. 操作感が不足した場合：専用Rustプロセス。
3. Pythonへの直接組込み：配布やFFI管理を引き受ける利点が明確になってから検討。

Rust側にはworkspace内パス依存と固定git依存がある。単独のソースファイルだけを取り込む構成ではなく、固定commitのソースツリーを依存として扱う方が現実的である。基準のworkspaceはRust `1.90`を指定している。

根拠：[Cargo.toml:6](/I:/code/lightcraft/Cargo.toml:6)、[Cargo.toml:13](/I:/code/lightcraft/Cargo.toml:13)、[crates/engine/Cargo.toml](/I:/code/lightcraft/crates/engine/Cargo.toml)。

推奨する追随方法：

- v0.9.1のcommitを固定する。
- GenzoRoom独自の薄い接続インターフェースの内側にLightCraft依存を閉じ込める。
- 設定全体と`process`、エンジンcommitを保存する。
- 更新時に設定互換性、代表設定の描画、要求集約、メモリ解放、Export設定共有を確認する。
- エンジン更新と既存写真のprocess更新を別操作として扱う。
- 未知のJSONキーを旧版Engineで読み直した場合の情報落ちを考慮する。

## 7. 制約、未実装、未検証事項

### 7.1 LightCraft本体変更なしで利用できる範囲

- headlessの常駐Session。
- Import、対象選択、設定取得。
- 個別control変更、複数control変更、部分JSON。
- Undoをまとめるinteraction。
- 縮小Previewと画像contentの取得。
- CPU固定。
- 同じ写真設定からの最終Export。
- メモリ内Sessionの利用。永続LightCraftライブラリを必須にしない構成。

### 7.2 小規模Rust Adapterで対応できる範囲

- 表示ごとの`StageCache`保持。
- Draft／Full品質の切替。
- request revision管理。
- 未開始要求を最新値へ集約。
- 古い結果の破棄、写真切替時の世代管理。
- メモリ内画像エンコードと独自IPC。
- 明示的なキャッシュ解放と予算調整。
- Exportの設定スナップショットとワーカー処理。

これらに必要な画像処理APIは既にあり、対話Previewを成立させるために新しい現像機能を本体へ追加する必要はない。

### 7.3 本体内部の改修が必要になる範囲

- 実行中RAWデコード／pipelineの細粒度・協調キャンセル。

以下を専用Adapterではなく既存MCPそのものへ追加したい場合も、MCP／headless側の変更が必要になる。

- StageCache付きPreview。
- Draft品質の外部指定。
- Previewの途中キャンセル。
- 公開プロトコル経由の細かなメモリ制御。

### 7.4 未確認事項

- Windowsでの連続スライダー操作の速度、初回Preview時間、更新待ち時間。
- 長時間動作のRSSとメモリ回収。
- 配布済みv0.9.1 Windows CLIバイナリでのMCP実接続。
- GenzoRoomの既存IPCとの適合、必要な実装量。
- WebView2での色表示、色管理、画像更新経路。
- PreviewとExportの実画像比較。
- 直接Python bindingのビルド・配布適合。
- 公開Rust APIの将来の互換性保証。

RAW入力互換性・画質については、既存のPixel 7 Pro／Pentax DNGの成功を今回再検証していない。リポジトリ自体はalpha段階で、カメラ色・描画忠実度などの品質課題を明記している。APIが存在することはLightroomとの描画同等性の証明ではない。

根拠：[ROADMAP.md](/I:/code/lightcraft/ROADMAP.md)、[docs/target-app-parity.md](/I:/code/lightcraft/docs/target-app-parity.md)、[docs/gaps.md](/I:/code/lightcraft/docs/gaps.md)。

## 8. GenzoRoomのRAW暗室Previewを実現する最小PoC案

以下は提案であり、実装・実行はしていない。

### 8.1 最初の構成

既存`lightcraft-cli.exe mcp --compact`を1プロセス常駐させる。

```text
WebView2のスライダー
  → GenzoRoom Python Backend
  → 常駐LightCraft CLIのstdio MCP
  → 設定変更・Preview生成
  → Base64 PNG
  → GenzoRoomの既存表示経路
```

### 8.2 処理手順

1. 子プロセスの環境変数に`LIGHTCRAFT_GPU=0`を設定して起動する。
2. MCP初期化を行う。stdoutはJSON応答として読み、stderrは別経路で消費する。
3. `import`で1枚だけ登録し、返された写真IDを保持する。必要に応じて`library.select`で対象を明示選択する。
4. `develop.controls`と`develop.get`を取得し、設定全体・明示的な`process`・エンジンcommitを保存する。
5. ドラッグ開始で`develop.beginInteraction`を実行する。
6. スライダー値を`develop.set`で更新し、`render_preview`を長辺1024pxで要求する。
7. Python側はPreviewを1件だけ実行中にし、待機値は最新の1件へ上書きする。要求を無制限にMCPへ送らない。
8. 写真切替・要求revisionで古い画像を識別し、必要なら表示を破棄する。
9. ドラッグ終了で最終値を適用し、`develop.endInteraction`を実行する。最終Previewを生成する。
10. Exportは同じSession・写真IDで`app.export`を呼ぶ。原寸なら`longEdge: 0`を明示する。headless Exportはサイズ未指定時に長辺3000pxを設定するため、原寸条件を省略しない。

Exportのサイズ既定値の根拠：[crates/mcp/src/headless.rs:63](/I:/code/lightcraft/crates/mcp/src/headless.rs:63) `export()`。

`command_run`経由の操作は`id`にEngineコマンドID、`params`に各コマンドのパラメータを指定する。`render_preview`は別toolとして呼び、返却image contentのBase64を受け取る。ここで示す手順はプロトコルの設計案で、GenzoRoomのコード変更案や実行済みスクリプトではない。

### 8.3 PoCの受入条件

既に成功しているRAW→JPEG変換の繰返しではなく、以下へ絞る。

- 連続変更で要求が滞留しないこと。
- 写真切替後に古い画像が表示されないこと。
- ドラッグ全体が1回のUndoになること。
- 設定・Process Versionを保存復元できること。
- PreviewとExportが同一の設定を参照すること。
- 初回／連続更新の所要時間とメモリ使用量を測定すること。

### 8.4 応答性が不足した場合の次段階

MCP経由の応答性が不足した場合、接続方式を専用Rust Adapterへ置き換える。

- `Session`を保持する。
- 表示ごとに`Arc<StageCache>`を保持する。
- 単一表示slotのジョブ管理を行い、実行中1件と最新待機要求を管理する。
- `render_job().with_stages(...)`を利用する。
- 操作中は`draft()`、操作終了後はFull品質を利用する。
- 完了時に`accept()`し、デコード済みソースを再利用する。
- 表示にはrequest revisionと写真世代を照合する。
- `Rgba8`からメモリ内で画像をエンコードし、必要な形式で返す。
- キャッシュ予算と破棄を明示管理する。

upstream依存をAdapter内に閉じ込め、GenzoRoom側の「開く・設定変更・Preview・Export・閉じる」という接続インターフェースを安定させる構成が妥当である。

## XMPによるRecipeバックアップ・交換の設計候補（2026-10-20）

本節は未実装の提案。[Engine APIのXMP調査](ENGINE_API.md#xmpサイドカー入出力の追加調査2026-10-20)で確認したLightCraft実装とGenzoRoom現状を前提にする。XMPはコンテナであり、異なる現像系の同等描画や、Recipe・履歴の相互変換を自動で成立させるものではない。

### 候補比較

| 候補 | 保持するもの・用途 | 制約・判断 |
|---|---|---|
| LightCraft設定だけを`lc:settings`へ | 将来LightCraftで編集した写真の完全なDevelopSettingsをLightCraftへ戻す | 現行GenzoRoom Recipe v18・History・入力識別・保存競合情報は運べない。LightCraft native交換用に限定する候補 |
| `lc:settings`＋GenzoRoom独自namespace | native設定とGenzoRoom情報を同じXMPへ保持 | 二者の意味を区別できる有力候補。namespace URI・field・schemaは未決定。LightCraftの所有対象`lc:*`へGenzoRoom独自情報を追加しない |
| GenzoRoom独自namespaceのみ | 現行JPEG Recipeのバックアップ・GenzoRoom間交換 | LightCraftにそのまま読ませて同じ描画を得られない。native設定がない場合に架空の`lc:settings`を生成しない |
| XMP＋別JSON manifest | XMPはnative設定・標準metadata、manifestは完全編集状態や詳細な入力識別 | XMP単体で完結しないが、未知namespaceを保持しない中継経路への依存を減らせる。原本と設定の対応・同梱単位の設計が必要 |

研究段階の推奨は、まずユーザーが明示的に保存・読み込む独立バックアップで検証し、Immich側sidecarの直接更新は別段階にすること。現在のDB保存・revisionによる競合処理をそのまま残し、XMPを無条件に正本へ変更しない。

### 保持が必要なGenzoRoom情報

`lc:settings`はLightCraft側Serde形式であり、GenzoRoom Recipe・Historyを追加しても未知fieldの往復保持は保証されない。次を独自namespaceまたはmanifestで扱う必要がある。

- バックアップ自身のschema version、描画エンジン種別、GenzoRoomのrecipe/processing version。LightCraftを使う場合はそのversion・commitと明示processも保持する案。
- 現行Recipe全体とenable状態。無効化中の値も保持し、見た目の一時的な無効化を値の消去へ変換しない。
- バックアップの対象入力（RAW original／JPEG original／Immich preview等）、識別情報・checksum方式。Asset IDは別Immich環境で一致するとは限らず、ファイル名やStack COVERだけで自動適用しない。
- 「現在の設定だけの交換」と「History/cursorを含む完全バックアップ」の区分。後者は既存の履歴連続性・currentRecipe整合性の検証が必要。LightCraftのinteraction/UndoとGenzoRoom Historyを同一視しない。
- 必要なら作成元のrevision等を来歴として保持するが、別環境へ復元するときの書込み権限・expectedRevisionを移植しない。復元先で通常の競合検証を行う案。

Recipeのバックアップは画像自体のバックアップではない。入力画像とエンジンの互換性がなければ元の描画再現を保証できない。

### RAW／JPEGと復元対象の分離

- RAWは将来のLightCraft DevelopSettingsをnativeに往復する候補。現行のImmich preview向けRecipeをRAW設定へ変換するのは別開発で、WB scale・色空間・露光・トーン・grading等の対応を実測してから判断する。
- JPEGは現行RecipeをGenzoRoom用payloadとして運ぶ候補と、LightCraftでJPEGに追加調整したnative設定を運ぶ候補を区別する。現行sRGB8処理とLightCraftの線形ソース処理を同等と仮定しない。
- 出力済みJPEGに元RAW用設定を自動再適用すると調整の二重適用になり得るため、元素材・現像済み成果物・設定の適用対象を明記する設計が必要。
- full命名を候補にするとRAW/JPEGの同stem衝突を避けやすい。ただしLightCraftの既存命名設定・所有者判定とImmichの優先規則を照合し、既存packetを見失わない移行方針は未決定。

### Immichとの責任分担

公式文書上のsidecar管理は標準metadata用で、Recipeの解釈・復元APIではない（[公式XMP資料](https://docs.immich.app/features/xmp-sidecars/)、2026-10-20確認）。GenzoRoomの明示バックアップの運搬先として使う案と、Immichに標準metadataを反映する操作を分けて設計する。

既存XMPへ統合する場合は、未知namespace、他アプリ設定、Immichが更新する標準propertyを保持し、同時更新・atomic write・失敗時復旧・権限・DISCOVER/SYNCの必要性を確認する。LightCraft側のmerge実装があることだけで、Immichを経由した全経路の保持や競合回避が成立するとはしない。NASの元画像隣へGenzoRoomが直接書く案は今回採用・実行していない。

### 未検証事項・次の設計課題

1. 隔離fixtureでRAW/JPEG別に保存→新Sessionで再読込→設定比較。process欠落/V1/V2/将来番号、WB scale、mask、未知fieldを含める。元画像のhash不変と既存XMP保護も確認する。
2. Recipe単体の交換と完全History復元の受入仕様、namespace URI、schema、payload上限、文字コード、XML/JSON検証、不正payload・未知版の扱いを決める。LightCraftで読めない`lc:settings`が別設定へfallbackする場合をGenzoRoom側で検出する必要がある。
3. プレビュー・original・成果物の識別、checksum、別Immichへの移行、同stem RAW/JPEG、virtual copy、複数編集案の扱いを決める。
4. 代表設定で元のGenzoRoom描画とLightCraft変換案を比較する。値の範囲が似ていることだけで無損失変換を宣言しない。
5. 実環境のImmich版を固定し、upload/download、DISCOVER/SYNC、metadata編集後の`lc:settings`・独自namespace保持、read-only mount、並行更新、再試行を検証する。既存JPEG exportの許可リストはRecipe搬送路として使えないため別経路を検討する。
6. 自動sidecar保存は最小接続PoCから分離し、明示保存・復元を先に検証する。今回これらのテスト、API実装、画像/XMP書込は行っていない。
