# RAW現像統合 Phase 1A 設計案

この文書は、GenzoRoomのWindows版Python BackendからLightCraft常駐headless MCPを管理し、基本的なJSON-RPC通信を行うPhase 1Aの実装前設計である。実装済み機能の説明ではない。本文では「確認済みの事実」と「設計案」を分ける。

## 1. 調査条件と証拠

| 項目 | 調査基準 |
|---|---|
| GenzoRoomリポジトリ | `I:\code\genzoroom` |
| 調査時ブランチ | `feature/lightcraft-integration` |
| 調査時HEAD | `b0a9694a2d5a64f7fc766759a9844263e66a6e13` |
| GenzoRoom作業ツリー | clean |
| LightCraft | v0.10.0 |
| LightCraft固定commit | `a2a41383c4fd62fa85a46ccd00998639221f2d3c` |
| LightCraftソース | `I:\code\raw-test\lightcraft-v0.10.0-gpu-poc` worktree |
| 対象環境 | Windows 11、Radeon RX 580 |

LightCraft本体リポジトリの通常checkout (`I:\code\lightcraft`) はv0.9.1だったため、指定commitのv0.10.0 worktreeを参照した。MCP・CLI・GPU関連の主要10ファイルについて、worktree上のGit blob hashが指定commitのblobと一致することを照合した。既存研究資料のv0.9.1／v0.10.0記録は変更していない。

GenzoRoom側の主要な根拠は、`backend/main.py::lifespan`、`backend/windows_local.py::LocalHost`／`LocalServer`／`main`、`backend/windows_managed.py::ManagedControl`、`backend/windows_runtime.py`、`backend/export_runtime.py::ExportRuntime`、`backend/thumbnail_scheduler.py::ThumbnailScheduler`、`backend/backend_logging.py::BackendLogger`、`desktop/src/backend_launch.rs::BackendLaunch`、`desktop/src/backend_process.rs::BackendProcess`、`desktop/src/lifecycle.rs::Lifecycle`、`backend/Dockerfile`、`Dockerfile.release`、`release/supervisor.py`である。

LightCraft側の主な根拠は、固定commitにある`apps/lightcraft-cli/src/main.rs::mcp`、`crates/mcp/src/server.rs::Server::{serve,handle_line,handle,request}`、`crates/mcp/src/progress.rs::Server::serve_stdio`／`progress_hook`、`crates/mcp/src/tools.rs`のtool定義・呼出し、`crates/mcp/src/headless.rs::Headless`、`crates/engine/src/cmd/query.rs`の`app.gpu`、`crates/gpu/src/backend.rs`、`crates/gpu/src/lib.rs`、`crates/engine/src/logging.rs`である。

調査は読み取り専用で、ビルド、LightCraft起動、MCP実接続、テスト、ブラウザ操作は行っていない。したがって以下の実装上の事実はソース確認であり、GenzoRoom統合後の実動作確認を意味しない。

## 2. GenzoRoom既存構造

### 共通Backend

`backend/main.py::lifespan`が共通FastAPI Backendのサービス所有者である。起動時にStorageと既存DBの検証、DB初期化、Immich設定に応じたExport Runtimeの生成、Thumbnail Cache／Schedulerの生成、Export復旧を行う。`app.state`にRuntimeやSchedulerを保持する。終了時はThumbnail Scheduler、Tag Repair、Export Runtimeの順に閉じる／完了を待つ。

既存非同期処理は`asyncio.create_task()`と`asyncio.Lock`を使うサービス単位のtask所有が中心である。Export Runtimeはthreadpoolでブロッキング処理を実行し、プロセス内のexport workerには`threading.Lock`も用いる。Thumbnail Schedulerは単一workerと`asyncio.Lock`による更新調停を持つ。Backend本番コードには外部子プロセス管理用の共通抽象は見つからなかった。

### Windows LocalHostとTauri

`backend/windows_local.py::main`はWindows専用entry pointである。Windows用接続・保存設定を準備してから`main.app`を読み込み、Uvicornを単一workerで起動する。`LocalHost`はBackend appを`/api`へmountし、その外側lifespanからBackendのrouter lifespanを明示的に実行する（ASGI mount単体では内側lifespanが自動実行されないため）。Uvicorn 0.52.4の`asyncio_loop_factory`はWindowsかつsubprocess不使用時に`ProactorEventLoop`を選択する。現在のreloadなし／単一worker設定ではWindowsのasyncio子プロセスAPIを使える。

Tauriは`BackendLaunch`でPython開発環境または凍結Backend executableを解決し、`BackendProcess`がBackendを起動・監視する。BackendとTauri間にはstdin/stdout上の専用managed control行プロトコルがあり、終了時はprepare／shutdownを使ってExportをdrainした後、Uvicornを終了させる。Windows Job ObjectはBackend childを所有し、Job handle close時の子プロセス終了制約を設定している。

Phase 1Aの設計判断としてLightCraftを起動・終了する主体はWindows Python Backendとする。TauriにはLightCraft専用のProcess管理やMCP通信を追加しない。通常のBackend子プロセス配下としてWindows Job Objectの保護範囲に置く。

### Dockerとの境界

Dockerは`backend/main.py::app`を直接起動し、配布Dockerも`backend/*.py`を取り込む。Windowsは`windows_local.py`がBackend appを包む。従って共通Backend lifespanにLightCraft起動を置くとDockerへ波及する。Windows `LocalHost`の外側lifespanでのみLightCraftを所有することにより、Dockerの起動経路と既存JPEG処理への影響を避ける。

## 3. LightCraft v0.10.0 MCPのソース確認事項

### 起動と標準入出力

CLIの`mcp()`はheadlessで`Headless::default()`を作り、`Server::serve_stdio(stdout)`へ渡す。推奨する起動引数は次のとおり。

```text
<絶対パス>\lightcraft-cli.exe mcp --headless --compact
```

`mcp`は接続先`--connect`がなければheadlessとなる。`--headless`はその選択を明示する。`--compact`はengine commandごとの`cmd_*` toolを省き、`command_run`等のhelper toolを残す。Phase 1Aでは`--connect`、`--library`、`--demo`、初期入力ファイルを使わず、メモリ内Sessionとする。

通信は**LF改行区切りのJSON-RPC 2.0 JSON**である。Content-Length framingではない。クライアントはstdinにJSON objectを1行ずつ書き、stdoutからLF行を読む。サーバーは応答行を書いてflushする。空行は無視する。stdoutはプロトコル専用、stderrはCLI／LightCraftログである。CLIのロガーもstderrへ記録する。

Serverのsession処理はserving threadで同期的に行われる。stdio transportはstdin readerとstdout writerを別threadにするが、複数のEngine操作が並列実行されるわけではない。進捗hookの特定境界でpingやcancel通知を取り扱うが、一般要求は直列である。

### 初期化とメッセージ形式

初期化要求は次の形式を使う。MCP protocol versionはソースで対応が確認できた`2025-06-18`を提示する。

```json
{"jsonrpc":"2.0","id":"1:1","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"genzoroom","version":"<GenzoRoom version>"}}}
```

応答は`jsonrpc`、同じID、`result`を含む。`result.protocolVersion`、`result.serverInfo.name`（`lightcraft`）、`result.serverInfo.version`（CLI package version）を検証する。成功後に以下のnotificationを送って初期化を完了する。

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

必要なら続けて`ping`要求を送り、`result`がobjectであることを確認する。ソース上のprotocol versionは`2025-06-18`、`2025-03-26`、`2024-11-05`を受け入れ、未知の要求versionには`2025-06-18`を返す。Serverはinitialized通知状態を記録するが、未初期化要求をすべて拒否する設計ではないため、クライアントが手順を順守する。

通常JSON-RPC要求の形は以下である。

```json
{"jsonrpc":"2.0","id":"2:1","method":"tools/call","params":{"name":"command_run","arguments":{"id":"app.gpu","params":{}}}}
```

応答IDは送信時のIDと一致する。IDはstringまたはnumberでよい。サーバーは`result`または`error`を返す。通知は`id`を含まず、応答を持たない。クライアントIDをgenerationと連番から生成し、対応表でpending Futureへ振り分ける。

### GPU情報取得

`app.gpu`は`crates/engine/src/cmd/query.rs`で定義されるEngine commandである。MCP `command_run` helper toolを通して呼び出す。MCPの成功応答内にある`result.structuredContent`から、少なくとも`enabled`、`available`、`adapter`、`reason`、`lastFallback`を検証して返す。これはGPU状態取得のための要求であり、LightCraft内部の`available()`は初回GPU device生成を行うので、初回呼出しにはdriver初期化時間がかかり得る。MCP通信自体がreadyでも、GPUが使えない場合はCPU fallbackになり得る。

toolの失敗はJSON-RPC `error`と`result.isError == true`の2種類を区別する。GPU情報が取得できないこととMCPプロセスが不通であることも別状態で扱う。

### 要求、通知、進捗、エラー、切断

通常server requestは同期処理で、応答IDは要求IDに対応する。Serverはserver→client requestを現状送らず、クライアント側に応答対応が必要なのはclient→server requestである。MCP progress tokenは一部の長時間headless Exportに実装されており、写真境界で進捗を送る。通知やpingがそのタイミングで処理される。これはPhase 1AのGPU状態取得に一般的な割込みや進捗応答があることを意味しない。

ソースに汎用要求timeoutはない。stdin EOFでserve loopが終わるが、実行中の同期Engine呼出しが即時停止するとは限らない。汎用`shutdown`／`exit` RPCはなく、クライアント側のstdin close、プロセスwait／killが終了手段となる。正常EOF時にはheadless objectがdropされる。

サーバー実装は空行を無視し、不正JSON入力にはparse error (`-32700`)を返す。invalid request (`-32600`)、method not found (`-32601`)、invalid params (`-32602`)、internal error (`-32603`)も実装されている。これは不正なサーバー出力やstdout汚染を許容して読み飛ばしてよい根拠ではない。stdout上の行が仕様外なら通信をfail closedする。

### GPU環境変数

固定commitのGPU backend実装では、`LIGHTCRAFT_GPU_BACKEND`が`WGPU_BACKEND`より先に解決される。`dx12`を指定でき、`off`でcompute GPUを無効化する。`LIGHTCRAFT_GPU=0`等でもprocess全体のGPU処理を無効化できる。選択値やGPU disableは`OnceLock`で初回解決後保持されるため、環境変更はprocess再起動を要する。Windowsのcompute既定もDX12で、`WGPU_DX12_COMPILER`未指定時はFXCを選ぶ実装である。

Phase 1AではBackendから子process専用の環境コピーを渡し、`LIGHTCRAFT_GPU_BACKEND=dx12`を明示する。CPU固定は診断・テスト設定として`off`を使える余地を設計する。Backend自身の環境変数を書き換えない。

## 4. Phase 1A実装設計案

### モジュールと責務境界

新規`backend/lightcraft_mcp.py`はtransport clientに限定する。役割はstdin行の送信、stdout常時読取、JSON-RPC行の検証、IDとFutureの対応付け、notificationの切り分け、timeout、RPC error／tool errorの返却である。プロセス生成・再起動・GPU policyを持たない。

新規`backend/lightcraft_runtime.py`は単一LightCraft instanceのmanagerとする。実行パス・環境の解決、`asyncio.create_subprocess_exec()`による起動、MCP初期化、状態・generation管理、`status()`／`ping()`／`get_gpu_info()`の公開、shutdown／restart、stderr reader、process exit監視を担当する。

Backend内の利用側が依存する最小interfaceは、概ね次の非同期操作にする。

```text
start() -> None  # 起動・初期化taskを所有して開始し、handshake完了を同期的に待たない
close() -> None
restart() -> None
status() -> LightCraftStatus
ping() -> None
get_gpu_info() -> GpuInfo
```

プロセス管理とMCP通信の境界を保ち、将来Rust Adapterが同等の操作を提供できるようにする。Phase 1Aに汎用plugin registry、任意MCP method公開、RAW編集interfaceを先取りしない。

### Lifespanと状態

Windows `LocalHost`の外側lifespanで、まず共通Backend lifespanへ入る。続いてmanagerを構成して`backend.state.lightcraft`に保持し、所有する起動・初期化taskを開始してから外側lifespanをyieldする。`start()`はtaskを登録してすぐ戻り、handshakeや初回GPU情報取得をawaitしてBackendのreadyを遅らせない。終了時はmanagerを閉じ、そのtaskとprocessの回収を完了してから共通Backend lifespanを終了させる。LightCraftの失敗は例外でBackend全体を停止させず、既存JPEG機能を継続可能にする。未設定は`disabled`、起動・初期化失敗は`failed`として状態公開する。

`--check-runtime`のオフライン検査ではLightCraftを起動しない。開発者・配布環境でLightCraft設定が無い場合も、JPEGのみのBackend起動を可能にする。

状態遷移案：

```text
disabled
stopped → starting → initializing → ready
                         ↓            ↓
                       failed ←───────┘
ready／failed → stopping → stopped
```

managerごとに`generation`を持ち、各起動で増加する。stdout reader、stderr reader、exit watcherは開始時のgenerationを捕捉する。完了時に現在generationと一致しなければ、再起動後の状態やpending mapを変更しない。close／restartはlifecycle lockで直列化する。closeは冪等とする。

### 要求の直列化と失敗回復

MCPクライアントは要求送信からresponse dispatchまで1つの`asyncio.Lock`を使い、同時実行は1要求に限定する。Lock待ちにもdeadlineを含め、期限切れなら要求を送らない。stdout readerは一つのtaskが所有してpending IDごとのFutureへ解決する。通知はID付き応答から分離する。

現行LightCraft側が同期直列処理であることと、Phase 1Aの要求数が少ないことから、クライアントで複数要求の多重化は導入しない。通知割込みに対して複雑な再入可能処理を作らず、将来必要になった場合に別途拡張する。

送信後timeout、EOF、BrokenPipe、非zero exit、不正応答を検出したconnectionは`failed`に遷移し、pending要求を確定エラーにする。timeout後もLightCraft内で同期操作が続いている可能性があるため、そのprocessへ後続要求を流さない。自動再送・自動restartはしない。呼出側が明示的にrestartしたとき、新generationのprocessを作る。

起動失敗、初期化失敗、途中失敗すべてで部分起動cleanupを行う。shutdownは受付停止、pending完了、stdin closeによるEOF、期限付きwait、必要時kill、kill後wait、reader task回収の順とする。提案する初期値はinitialize 10秒、ping 5秒、初回GPU情報15秒、graceful EOF後wait 3秒、kill後回収wait 2秒。これらは実測済み要件ではなく、実装時に調整可能な設計初期値である。

### stdout／stderrと機密情報

stdout readerはUTF-8のLF行を最大1 MiBで受け取り、JSON object、`jsonrpc == "2.0"`、ID形式、`result`か`error`の形式を検証する。過大行、不正UTF-8／JSON、途中EOF、response形式不正、未知／重複response IDはconnection errorとして扱い、行のスキップによる継続はしない。サーバーのstdout汚染を通常ログとして隠さない。

stderrは必ず独立taskで継続的に読み、pipe詰まりを防ぐ。ただし生stderr、任意エラー本文、写真path、RAW情報、環境変数をBackend診断ログへ転送しない。既知ログ分類の必要があれば、許可した短い分類値だけへ変換し、原文は保持しない。GPU情報の正本は`app.gpu`構造化応答とする。

Backend構造化ログは`backend_logger`を使う。起動開始／ready／正常終了はinfo、GPU unavailable等の継続可能な異常はwarn、MCP起動不能・通信断など必要操作失敗はerror、generation・要求ID・処理時間・終了コード等の限定された技術情報はdebugとする。実行ファイル絶対path、argv全文、env、raw JSON-RPC、stdin/stdout/stderr本文、画像／Recipe／Historyは記録しない。ログ追加失敗は機能を失敗させない。

### 実行ファイル指定とバージョン

`GENZOROOM_LIGHTCRAFT_EXE`でexeの絶対パスを指定する。未設定時はLightCraft機能を`disabled`にしてBackendを起動する。Phase 1AではPATH探索や既定ディレクトリ推測を行わない。存在・通常ファイル・絶対pathを検証し、shellなしで`create_subprocess_exec`を呼ぶ。

初期化応答から`serverInfo.name == "lightcraft"`、`serverInfo.version == "0.10.0"`を検証する。MCP handshakeはcommitを返さない。開発時は実行ファイルのSHA-256を測定・記録し、検証再現性のために調査記録と紐づけるが、事前登録hashとの一致を起動必須条件にしない。hashを記録する場合も診断ログへは絶対pathを含めず、安全なartifact metadataとして扱う。

子processは`stdin=PIPE`、`stdout=PIPE`、`stderr=PIPE`、`shell=False`、`cwd`は必要な場合に明示する。stdoutを親Backendの制御出力へ混ぜない。起動時は親環境のコピーを元に、LightCraftへ不要な秘密情報やGPU overrideを引き継がない環境を構成してから`LIGHTCRAFT_GPU_BACKEND=dx12`を設定する。どの親env keyを除去するかは実装時にallowlist／denylistを明確化する。親processの`os.environ`は変更しない。

### Windows限定

managerの生成箇所を`windows_local.py`のWindows LocalHost lifespanに限定する。共通`main.py` lifespan、Linux Dockerの`main:app`起動経路、Docker supervisorへLightCraft起動処理を追加しない。共通Backend appに置く状態はWindows LocalHostが設定したときだけ存在する任意stateとし、共通JPEG endpointはこれに依存させない。

Windows配布版はPyInstaller frozen Backendから外部exeを起動する。frozen Python由来のDLL search environmentがLightCraftに不要な影響を与えないか、process env構成を確認する必要がある。子processがBackendと同じWindows Job Object内で終了することも、Windows実機で検証する。

## 5. 変更予定ファイルとテスト計画

以下は実装時の予定であり、本設計文書作成時点で変更したファイルではない。

| ファイル | Phase 1Aでの予定 |
|---|---|
| 新規`backend/lightcraft_mcp.py` | JSON-RPC stdio transport、ID対応、応答検証、timeout |
| 新規`backend/lightcraft_runtime.py` | Windows専用process manager、設定、lifecycle、generation、GPU/status |
| `backend/windows_local.py` | LocalHost lifespanへの任意manager所有・終了連動 |
| 新規`backend/tests/test_lightcraft_mcp.py` | fake streamsによるframing／JSON-RPC単体テスト |
| 新規`backend/tests/test_lightcraft_runtime.py` | fake childによる起動・終了・故障・世代管理試験 |
| `backend/tests/test_windows_local.py` | Windows LocalHostの未設定・起動失敗・shutdown接続テスト |
| `docs/architecture.md` | 実装後に状態所有者／更新条件／generation不変条件を記録し、この設計案への参照を更新 |

`backend/main.py`、Tauri Rust、Dockerfile、requirements、Frontend、Recipe／History、README、CHANGELOGは、この境界であれば変更不要の見込みである。実際の実装diffで依存を確認する。

必須テストは次のとおり。

1. 設定未指定時にmanagerがdisabledになり、共通BackendとJPEG機能のlifespanを妨げない。
2. 相対path／不存在exe／不正応答version／起動例外を安全に失敗へ変換する。
3. 起動引数、shellなし、stdio pipe、GPU env分離、親environment不変更を確認する。
4. initialize→initialized→pingの順序、serverInfo検査、GPU `tools/call`とstructuredContentの取得を確認する。
5. CRLF、Unicode、分割読込み、連続行、空行、不正JSON／UTF-8、過大行、EOF途中切断を確認する。
6. 応答IDの対応付け、通知分離、JSON-RPC errorとtool `isError`の区別、未知／重複ID検出を確認する。
7. 同時呼出しで最大1要求だけ送信されることと、Lock待ちtimeout時に送信しないことを確認する。
8. 送信後timeout、BrokenPipe、子process異常終了、stdout閉鎖でfailedとなり、pendingが終了することを確認する。
9. restart generation後に旧reader／watcherが新stateを変更できないこと、自動再送されないことを確認する。
10. closeの冪等性、EOF後のwait、kill後wait、部分起動失敗cleanup、stderr排出task回収を確認する。
11. 生stderr、実行path、資格情報、任意応答本文、写真名がログに残らないことを確認する。
12. Linux/Docker相当の共通`main.app`起動時にはmanagerを作らないことを確認する。

完了条件は、focused Backend単体・Windows LocalHost統合テストが成功し、`git diff --check`が成功し、起動からcloseまでのprocess/task所有者とgeneration不変条件をテストで説明できることである。実機の配布版MCP接続・GPU応答・Job Object配下の終了は単体テストと区別して報告する。これは実装指示時の条件であり、今回実施した検証ではない。

## 6. 未検証事項とリスク

- GenzoRoom Python BackendからのLightCraft MCP実接続、初期化遅延、長時間運用、異常終了時の挙動は未検証。
- v0.10.0のWindows RX 580 DX12 PoCは[GPU PoC記録](GPU_POC_V0.10.0.md)にある既存の別検証であり、本設計作業で再現・再実行していない。PoC実測は2素材と限られた設定に関するもので全RAW／全設定の品質保証ではない。
- `app.gpu`の初回実行でGPU device creationが同期的に起き、タイムアウト時にdriver内処理が残る可能性がある。プロセス分離は必要だがkill応答やdriver回復の実機確認が要る。
- SHA-256の記録方法・保管場所は未確定。hashと固定commitの対応が配布来歴で保証されるわけではなく、Phase 1Aの起動条件にも使わない。
- frozen BackendのDLL検索環境とLightCraft CLIの依存DLL解決は実機未確認。
- Backend異常終了時にWindows Job ObjectがLightCraft孫processも回収するか未確認。
- GPU情報照会をBackend startup中にawaitすると、Tauriの30秒起動期限やWindows ready表示へ影響する可能性がある。設計上はlifespan yield後の所有taskで起動し、起動task自体にも期限を置く。ready前にMCPが必須になる将来要件があれば再設計する。
- stderrの原文はGPU診断に役立つ一方、任意path等を含む可能性があり、既存ログへ無制限に転送しない。
- 実行ファイル同梱、installer配置、配布ライセンス・NOTICEは未確定。

## 7. Phase 1Bへの引継ぎ

Phase 1AではLightCraftプロセスの起動・停止、初期化、ping、GPU情報、基本障害処理までを扱う。以後は以下を別設計・検証する。

- RAW import、Session内photo IDの保持と選択。
- DevelopSettings取得・変更、Recipeとの対応、Process version・engine commitの保存責任。
- Preview生成・Base64／画像サイズ上限、転送メモリ、WebView表示。
- 連続操作時のPreview要求集約（実行中1件＋最新待機1件）、古いgeneration／revision結果の破棄。
- 写真切替と進行中要求のキャンセル境界。LightCraftの進捗通知が全Engine処理を割り込めるとは見なさない。
- Process再起動を越える再import・設定復元。Phase 1AのSessionはメモリ内で揮発する。
- Exportの停止・ファイル書込み・登録処理とshutdown期限。Phase 1Aの強制kill方針をそのまま適用しない。
- Session＋StageCacheを使うRust Adapterとの性能比較。Python側境界は`status`／`ping`／GPU取得等の必要操作に留め、将来の置換点を保つ。
- Recipe、History、Undo、Immich Stack／Album、暗室UIの整合性。これらはPhase 1Aの対象外。

## 実装後の限定修正追記

2026-10-21の限定コード監査で見つかった終了・回収経路を補強した。元の設計判断と本体の記録は保持する。

- Windows UNC pathは遅延・停止する可能性のあるネットワークI/Oを避けるため実行fileとして受け付けない。hash検査は10秒のstartup期限を持つ専用daemon threadで実行する。worker threadはOS I/Oを強制停止できないため、期限後に残っている間は次の検査を拒否し、Backend shutdownを待たせない。
- MCP frame違反後は接続を失敗として固定し、stdoutをJSONとして再処理せず、bounded chunkでEOFまで破棄排出する。これにより実プロセスのpipe transportが終了を認識できる。
- Session ownerのcancel中も別cleanup taskでprocess回収を続ける。exit watcherが同時にcancelされていた場合は新しい`process.wait()` watcherを作成する。外部呼出側のcancelはcleanupとownership更新後に伝播する。

この追記の回帰検証では、実asyncio subprocessによる1 MiB超stdoutの排出、inspection中のclose・期限超過、owner／exit watcher同時cancelを追加し、関連Backendテスト117件が成功した。実LightCraft、RX 580、frozen DLL検索、Job Objectによる孫process回収の未検証状態は変わらない。
