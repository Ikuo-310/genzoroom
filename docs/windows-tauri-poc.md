# Windows Tauri 2 開発・同梱版（Phase 3B）

既存React UIをTauri 2 / WebView2で表示するWindowsホストです。開発起動ではリポジトリの`.venv`、Phase 3Bの同梱版ではPyInstaller onedirのBackendを自動起動し、終了も管理します。Immich接続はSettingsで登録し、APIキーはWindows資格情報マネージャーへ保存します。インストーラー、LightCraft、RAW現像は含みません。以下の従来PoC手順・保存先は開発モードのものです。同梱版の差分は末尾を参照してください。

## Phase 3B：同梱版のビルドと起動（2026-10-19）

Windows x64、CPython 3.14、uv、Node.js（package.jsonの下限以上）／npm、MSVC向けRust、C++ Build Tools、Windows SDKを用意します。実行先ではWebView2 Runtimeが必要です。Python・Node.js・RustはビルドPCだけに必要で、同梱版の起動条件には含みません。WebView2導入とインストーラーはPhase 3Cで扱います。

```powershell
Set-Location I:\code\genzoroom
./desktop/packaging/build.ps1
# 別のCPython 3.14を明示する場合:
# ./desktop/packaging/build.ps1 -PythonPath C:\path\to\python.exe
```

スクリプトは配布専用`desktop/packaging/.venv`を作成し、hash付き`runtime.lock`と`build.lock`へ同期します。既存の開発用`.venv`へビルド依存を追加しません。Frontendの`npm ci`・TypeScript/Vite build、PyInstaller 6.22.3／hooks-contrib 2026.8のonedir生成、オフラインネイティブ自己診断、Tauri resourcesのコピー、Release build、コピー後のファイル照合を順に実施します。resourcesへの旧DLL残留を防ぐため、配布専用の生成resourcesと当該Cargo packageだけをcleanし、他の依存ビルドは再利用します。照合は不足・改変だけでなく余剰ファイルも拒否します。UPX、Shell Plugin、Installerは使いません。初回の依存取得にはネットワークが必要です。

成果物は`desktop/packaging/out/<日時-ID>/application/`です。フォルダー全体を別の場所へコピーし、その中の`genzoroom-desktop.exe`を起動してください。`backend/`を分離すると`backend_bundle_missing`で失敗し、開発用Pythonへフォールバックしません。成功の判定は同じrun直下の`distribution-complete.json`です。途中失敗時のフォルダーを配布しないでください。`-Smoke`付きビルドはfixture専用機能を含み、配布用には使いません。

```text
application/
  genzoroom-desktop.exe          # GUI subsystem, x64
  backend/
    genzoroom-backend.exe        # console subsystem, x64; Rust hides its window
    _internal/                  # Python DLL, native extensions, CA, frontend/dist
    licenses/                   # collected original notices, subject to final review
    build-manifest.json
    collection.json             # collected module/DLL/data names
    inventory.json              # per-file SHA-256/size, license review checklist
```

`bundled-backend` Cargo featureが配布モードを明示します。Release/Debugの暗黙判定はしません。通常Cargo開発ビルドは従来どおり`.venv`です。同梱版は実行ファイル隣の`backend`を絶対パスで解決し、その起動設定をLifecycleが保持して接続変更・回復再起動にも再利用します。Frontendは凍結モジュール位置の`frontend/dist`からBackendが配信し、オリジン・認証Cookie・画像URL・私有パイプ・Job Objectは従来と同じです。ReactはTauri assetsから配信しません。

通常のビルド手順は`tauri.bundle.conf.json`をmergeし、Tauriのresources出力そのものを検証してapplicationへコピーします。単に`cargo build --features bundled-backend`だけではresourcesの準備になりません。ビルドscriptを使ってください。gitignoreの既存`.venv/`・`out/`・`dist/`規則により生成物はGit対象外です。依存更新時は`.in`を変更し、lockヘッダーの`uv pip compile --generate-hashes --python-version 3.14 --python-platform windows`を再実行してレビューします。

### 正式データ領域と診断

同梱版は`%LOCALAPPDATA%\GenzoRoom\`、開発PoCは従来の`WindowsPoC\`を使います。正式版の`connection.json`、`profiles/<ID>/data/genzoroom.db`、`profiles/<ID>/cache/thumbnails`、`webview2/`、`desktop-session.dpapi`はすべて正式ルートから解決します。資格情報参照は`GenzoRoom/Immich/<ID>`で、PoCの`GenzoRoom/WindowsPoC/Immich/<ID>`を読みません。PoCの探索・移行・削除はありません。正式ルートの更新でも保存データを保持します。DBスキーマは変更していません。共有Mutexは既存の名前を維持し、PoCと正式版の同時UI起動を拒否します。

初回は接続未設定のSettingsから登録します。環境変数は通常起動の設定元にしません。診断用`--environment-backend`は引き続き明示モードとして利用でき、正式版でも新しい一時プロファイルを使います。手動起動を使う場合は、同じ配布物の`backend/genzoroom-backend.exe --desktop`を起動してから、ホストを`--manual-backend`で起動します。開発版と正式版のハンドオフ・資格情報は相互利用しません。

ホストの起動失敗はReactに依存しないダイアログと`logs/host.jsonl`へ固定コードで通知します。`backend_bundle_missing`、`backend_spawn_failed`、`local_port_unavailable`、`backend_startup_timeout`等を区別します。ログは64KiBを超えると前世代1本へローテーションします。Backend stderr、URL、APIキー、Cookie、tokenは保存しません。ログ書き込み失敗は本来のエラーを隠しません。Backendを復旧できない場合はホストを閉じ、固定コードを確認し、配布フォルダーの欠落やポート競合を解消して再起動してください。データ削除による復旧は行いません。

### Phase 3Bの検証と残課題

実際のPyInstaller成果物をリポジトリ外へコピーし、私有パイプ・DPAPI/HMAC・Cookie、API/SPA/JPEG、接続変更再起動、正常終了・異常終了のJob回収、ポート競合、SQLite障害回復、JSON保存を生成画像とloopback Immich fixtureで確認しました。正式版用のランダム資格情報参照だけを作成・後始末し、実ユーザーの設定・DB・NASは使っていません。PoC sentinelが保持されることもfixtureで検証します。単体の`--check-runtime`はPillow ICC、JPEG decode/render/encode、NumPy、SQLite、certifi CA読込みをオフラインで検証し、ユーザーデータを作成しません。CA読込み成功は実サーバーへのTLS疎通成功を意味しません。

配布manifestにはvalidation版、commit、working-tree dirty、source digest、Python／依存バージョンを記録し、完了manifestにはNode/npm/Rust/Cargo/uvとホストSHA-256も記録します。署名・インストーラー・自動更新はありません。開発環境なしのクリーンWindows 11 VM、実ImmichとのHTTPS、実写真Export、GUI保存ダイアログやOS入力の最終手動確認は未実施で、Phase 3Dの対象です。

ライセンス一覧は基礎資料で、適合保証ではありません。GenzoRoomのAGPL-3.0-only対応ソースとビルド手順の提供、Python／PyInstaller bootloader例外、NumPy同梱GCC runtime等のソース条件、Pillow各codec、certifi MPL、Microsoft runtime、Rust/FrontendのNOTICEをPhase 3Cの正式配布前に確認してください。標準NumPy hookが拡張内部からの参照用に収集する`_multiarray_tests`は保持していますが、プロジェクトのtests/fixture・pytest・開発ツールは同梱していません。

## 前提

- Phase 1Aの[Windowsローカル起動環境](windows-local-poc.md)。Python 3.14仮想環境とFrontend依存関係を準備します。
- Rust stable（MSVCターゲット）、Visual StudioのC++ビルドツール、Windows SDK、WebView2 Runtime。Tauriの[Windows prerequisites](https://v2.tauri.app/start/prerequisites/)に従います。
- Tauri CLIや追加のNode UIフレームワークは不要です。Cargo.lockで固定した依存関係を使います。

## 自動起動（通常）

Frontendをビルドした後、Tauriを起動します。Immich環境変数は不要で、設定されていても通常モードでは使用しません。既に動いているBackendがある場合は、その所有者側で保存・停止を完了してください。既存Backendを自動で再利用したり停止したりしません。

```powershell
Set-Location I:\code\genzoroom\frontend
npm run build
Set-Location ..
cargo run --manifest-path desktop/Cargo.toml --locked
```

Rustは固定したPythonパスと引数を直接起動し、シェル経由のコマンドを組み立てません。作業ディレクトリは`backend`、起動経路は`windows_local.py --desktop --managed`です。起動固有IDを私有パイプで渡し、そのIDを含むDPAPI情報とHMAC照合に成功してからウィンドウを開きます。Pythonが資格情報マネージャーからAPIキーを読み、mainのimport前にそのプロセス内の既存Immich環境変数へ設定します。Rustへ秘密を返さず、コマンド引数やハンドオフにも含めません。固定ポート3191の競合、30秒の起動待ちタイムアウト、起動失敗は固定エラーコードで終了します。

初回はSettingsの「Windows版のImmich接続」でHTTPまたはHTTPSのURLとAPIキーを入力し、接続テスト後に保存します。テストは`GET /api/users/me`の認証と有効なユーザーID取得（`user.read`）だけを確認します。Export・アップロード・STACK操作などの権限は実操作で別途確認してください。保存直前にも認証を再確認します。保存済みキーをUIへ読み戻す機能はありません。同じURLの空欄キーは保存済みキーを保持します。

保存・削除後はPhase 2Aの編集保存、Export Stop永続化、現在項目の完了、Backend終了確認を経て、新設定でBackendを起動します。成功後に新しい認証を行い、React文書と接続先固有のsessionStorageを破棄してGalleryを表示します。終了前保存に失敗した場合は旧Backendを維持し、保存済み設定は反映待ちです。Settingsの「保存済み設定を反映・再起動を再試行」で再試行できます。

## 保存形式・プロファイル・復旧

- `%LOCALAPPDATA%\GenzoRoom\WindowsPoC\connection.json`：version、selected（正規化URL、認証済みuserId、ランダムprofile ID、資格情報参照ID）、未完了資格情報削除のcleanup ID一覧。APIキーは含みません。
- Windows資格情報マネージャー：現在ユーザーのGeneric Credential。参照名は`GenzoRoom/WindowsPoC/Immich/<ランダムID>`、同じPCの次回ログオンでも利用できます。利用不能時に平文へフォールバックしません。
- `profiles/<profile ID>/data/genzoroom.db`と`profiles/<profile ID>/cache/thumbnails`：Recipe、History、Queue、Export履歴、サムネイルを接続プロファイルごとに分離します。正規化URLと認証済みユーザーIDが現在の保存済み接続と一致すればprofile IDを維持し、APIキーだけの変更でもデータを引き継ぎます。URLまたはユーザーIDが異なる場合は新しいprofile IDを発行します。同一の資格情報・接続設定を保存した場合は既存資格情報を再利用し、Backendを再起動しません。過去プロファイルを推測で選択・移行・統合せず、そのファイルは保持します。
- 通常の再起動では保存済みprofileを使いますが、先にCredential ManagerのキーでユーザーIDを再検証します。別ユーザー、認証失敗、接続不能などでは旧profileを開かず、`profiles/unconfigured`でSettingsを利用可能にします。旧WindowsPoC直下のDBは自動移行しません。
- 保存後の再起動、または通常起動で選択済みDBを開けずBackend起動に失敗した場合は、接続未設定の回復Backendを起動します。保存済み設定と以前のprofileは保持し、Settingsで修正または再起動再試行できます。DBのロック・アクセス権・対応アプリ版を確認し、DBを保全してから復旧してください。同じURL／ユーザーの再保存では空のprofileへ切り替わりません。空のprofileからやり直す場合は、明示的に接続設定を削除してから再登録します（旧DB・キャッシュは残ります）。通常起動のポート競合・タイムアウトは回復起動へ進まず固定エラーで終了します。回復Backendも起動できない場合はポート・Python環境・保存ルートへのアクセスを解消してTauriを再起動してください。
- 資格情報の更新は新参照へ書き込み、JSON参照を原子的に切り替えた後で旧資格情報を削除します。書き込み失敗時は旧参照と選択設定を維持します。削除失敗はcleanupとして保持・表示し、接続削除の再試行で回収します。接続設定の削除は資格情報だけを削除し、DBやキャッシュは保持します。JSONが破損している場合は上書きせず、停止後に`connection.json`を退避して再登録してください。資格情報マネージャーに残る不要なGenzoRoom参照は所有者が確認して削除できます。

環境変数を使う自動起動の診断モードは`cargo run --manifest-path desktop/Cargo.toml --locked -- --environment-backend`です。保存済み設定とは混用せず、接続設定欄は読み取り専用になります。診断モードと手動起動は毎回`profiles/environment-<ランダムID>`を作成し、過去のRecipe／Queueを再利用しません。Docker版は従来どおり環境変数と`/genzoroom`を使います。

通常終了ではExportのStopを永続化し、暗室の既存保存処理が成功するまでウィンドウを保持します。保存失敗時は終了を中止し、戻って再試行できます。保存成功後も処理中のExport 1件が完了するまで待ち、次の項目は開始しません。待ち時間には強制終了タイムアウトを設けません。残るQueue項目は既存のStop／次回復旧仕様で扱います。

BackendはWindows Job Objectへ割り当ててから実行を再開します。通常終了は私有パイプで要求し、Uvicorn終了と子プロセスの終了を確認するまで所有権を保持します。Tauriが異常終了した場合だけ、Job Objectのkill-on-closeで子孫プロセスを回収します。この異常終了では編集中データや実行中Exportの完了を保証できず、既存の永続化済み状態と復旧に依存します。

## 手動起動（Phase 1Bの診断用）

まずFrontendをビルドします。

```powershell
Set-Location I:\code\genzoroom\frontend
npm run build
```

**ターミナルA**でBackendを手動起動します。Phase 1Aの通常ブラウザー用Backendが動いている場合は、保存とExport停止を完了してから終了してください。

```powershell
Set-Location I:\code\genzoroom\backend
$env:IMMICH_URL = 'https://your-immich.example'
$immichKeyInput = Read-Host 'Immich API key' -AsSecureString
$env:IMMICH_API_KEY = [System.Net.NetworkCredential]::new('', $immichKeyInput).Password
try {
    & '..\.venv\Scripts\python.exe' windows_local.py --desktop
} finally {
    Remove-Item Env:IMMICH_API_KEY -ErrorAction SilentlyContinue
    Remove-Variable immichKeyInput -ErrorAction SilentlyContinue
}
```

`Windows PoC ready`が表示されたら、**別のターミナルB**でTauriを起動します。このターミナルにはImmich URL・APIキーの設定は不要です。

```powershell
Set-Location I:\code\genzoroom
cargo run --manifest-path desktop/Cargo.toml --locked -- --manual-backend
```

Tauriは暗号化した受け渡し情報を読み、起動済みBackendのインスタンスを照合した後、WebView2内でPhase 1Aの一回限りの認証を行います。API・画像・SPAは引き続き同じ`http://127.0.0.1:<port>`から読み込みます。

別プロセスがポートを使用している場合、Backendは従来どおり`local_port_unavailable`で停止します。Backendの未起動、古い受け渡し情報、不一致のHTTP応答、リダイレクト、認証済み起動情報をTauriが検出した場合も、別プロセスへフォールバックしません。`--check-backend`でウィンドウを開かずに接続確認できます。

```powershell
cargo run --manifest-path desktop/Cargo.toml --locked -- --check-backend
```

認証は起動ごとに一回です。Tauriを閉じて再起動する場合はBackendも手動で再起動してください。通常ブラウザーで先に認証したセッションをTauriへコピーする機能はありません。Backendの`--port`を明示変更した場合は、受け渡し情報から同じポートを使用します。自動ポート探索は行いません。

## ウィンドウと操作

- `dragDropEnabled: false`を設定し、STACK管理のHTML Drag & Dropへイベントを渡します。
- React側のレイアウト、ショートカット、Slider、Viewer、Filmstrip、Undo/Redo、WebGPU／CPUフォールバック処理は変更していません。
- SettingsのPrimary修飾クリックによる`window.open('/developer')`は、同じWebView2プロファイルのDiagnosticsウィンドウを開きます。ネイティブメニューの`Window > Developer Diagnostics`からも開けます。
- `Window > Full screen`で全画面を切り替えます。新しいキーボードアクセラレーターは登録していません。同じメニューから戻ります。
- 両ウィンドウは検証済みBackendと同じオリジンへの遷移だけを許可し、Diagnostics以外のポップアップは拒否します。WebViewの開発者ツールは利用可能です。
- DiagnosticsのJSONは既存のBlob／`<a download>`経路を使い、Windowsホストがネイティブの保存先選択を表示します。Full／JPEG-only／WebGPU-onlyと既存ログJSONの命名・UTF-8内容を維持し、キャンセルは正常終了、保存失敗は既存UIのエラー表示になります。通常ブラウザーでは従来どおりブラウザー標準ダウンロードです。

保存ルートはPhase 1Aと同じですが、DB・キャッシュは上記の接続プロファイル配下です。WebView2の専用プロファイルは`%LOCALAPPDATA%\GenzoRoom\WindowsPoC\webview2`です。通常ブラウザーとはCookie・UI設定が別になります。ポートを変えるとオリジン単位のUI設定も変わります。

## 認証情報の受け渡し

Phase 1Aの起動用URLは通常ブラウザーへ直接渡す方式で、Tauriが安全に取得する経路がありませんでした。`--desktop`を明示した場合だけ、Backendのstartup完了後に次を追加します。

1. `%LOCALAPPDATA%\GenzoRoom\WindowsPoC\desktop-session.dpapi`へ、Windowsのユーザー単位DPAPIで暗号化した一時情報を原子的に書き込みます。ポート・一回限りのbootstrap token・インスタンス照合用キーだけを含み、Immich APIキーやCookieは含みません。平文の一時ファイルは作りません。
2. Tauriは同じWindowsユーザーで復号し、ランダムchallengeへのHMAC応答を`/__local/desktop-ready`で検証します。照合用キーもbootstrap tokenもこのリクエストには送信しません。HTTPクライアントはプロキシ・リダイレクトを使用しません。
3. 検証成功後にだけWebView2へbootstrap URLを渡します。フラグメント除去、同一OriginのPOST、HttpOnly・SameSite=Strict CookieはPhase 1Aの既存経路です。Cookieをネイティブコードから注入しません。

通常終了時に自分が作成した暗号化情報を削除します。強制終了で残っても、次回は新しい起動情報で置換され、停止したBackendや別インスタンスの応答では照合に成功しません。平文URL・キー・Cookieをログやコマンド引数に出力しません。

Tauriは検証済みの厳密なローカルOrigin・mainウィンドウだけに、終了準備への応答用`desktop_lifecycle`コマンドを許可します。Shell・Filesystem・HTTPプラグイン等の権限は付与しません。Diagnosticsにはこの権限を付与しません。DPAPIも同じユーザー権限の悪意あるプロセスから秘密を隔離するものではありません。

## 停止

自動起動モードではウィンドウを閉じ、保存とExport現在項目の完了、Backend停止を待ちます。保存失敗時は終了しません。手動モードでも暗室保存を待ちますが、BackendやExportの停止は管理しません。手動モードではUIのCancel後に現在項目の完了を待ち、Tauriを閉じた後、ターミナルAでCtrl+Cを一度押します。Export復旧動作と強制終了時の制限は[Phase 1Aの手順](windows-local-poc.md#停止とexport)と同じです。

## 自動検証

```powershell
Set-Location I:\code\genzoroom
cargo test --manifest-path desktop/Cargo.toml --locked
cargo fmt --manifest-path desktop/Cargo.toml -- --check
cargo build --manifest-path desktop/Cargo.toml --locked
```

実WebView2の自動スモーク検証は、通常ビルドに含まれない`webview-smoke`機能を明示します。一時領域にテスト用Backendと生成JPEGを配信するループバックfixtureを起動し、NASには接続しません。テストウィンドウは自動終了します。通常利用中のTauriを閉じてから実施してください。

```powershell
Set-Location I:\code\genzoroom
cargo build --manifest-path desktop/Cargo.toml --locked --features webview-smoke
Set-Location backend
$env:GENZOROOM_WEBVIEW_SMOKE = '1'
try {
    & '..\.venv\Scripts\python.exe' -m pytest tests/test_windows_process.py tests/test_windows_local.py -k 'windows_process or (windows_cli_build_startup_and_graceful_shutdown and desktop)' -q -s
} finally {
    Remove-Item Env:GENZOROOM_WEBVIEW_SMOKE
}
```

このスモークは正規認証、React表示、APIエラーのJSON応答、画像URLからのJPEG／Canvas読み取り、Diagnostics別窓のCookie共有、既存WebGPU診断の実行を確認します。GPUがない環境では`gpuResults: false`も想定されるため、GPU描画の合否は出力を区別してください。手操作や実Immich写真の画質・速度を保証する検証ではありません。

`GenzoRoom keyboard smoke`は実WebView2内で合成DOMイベントを生成し、`keydown`／`keyup`のwindow・documentへの到達、key／code・修飾キー、targetとactiveElement、GalleryのAキー、入力欄でCtrl+Aをアプリ側が横取りしないことを確認します。OSからの実キー入力やネイティブメニューとのフォーカス往復を保証するものではありません。暗室のG、Ctrl+Shift+矢印、IME・入力欄保護、終了失敗後の復帰はFrontend回帰テストでも確認します。

## 実機確認表

| 対象 | 確認する操作 |
| --- | --- |
| Gallery / Calendar / Albums / Favorites | 実Immich一覧、タブ移動、日付・アルバム遷移、選択、画像、再読み込み |
| STACK管理 | 内部ドラッグ、ドロップ可否、ドラッグ画像、キャンセル、修飾クリック、Undo/Redo |
| 暗室 | Sliderドラッグ・ホイール・数値入力、キーボード・IME、Undo/Redo、保存してHomeへ戻る |
| Filmstrip / Viewer | ホイール、前後移動、拡大・移動、押下中Before表示、切替中・保存失敗時の操作抑止 |
| WebGPU | 設定ON/OFF、初期化、連続プレビュー更新、画像変更、CPUフォールバック、実写真の色 |
| Developer Diagnostics | Primaryクリックとネイティブメニュー、タブ移動、WebGPU・JPEG診断、JSON保存 |
| ウィンドウ | リサイズ、最小化・復帰、DPIの異なる画面間移動、全画面往復、Alt+Tab後のフォーカス・キー解放 |
| 終了・再起動 | 未保存編集の保存待ち・保存失敗と再試行、Export現在項目だけの完了待ち、正常終了後の子Backend消滅、異常終了後の復旧、手動モードでBackendを残すこと、新しい認証での再起動 |

自動スモークで成立した項目と、この表の人による実機確認は区別して記録してください。

## Phase 1・2 完了判定と検証範囲（2026-10-19）

Phase 1A〜2Cの実装、Phase 1・2横断監査、および監査Finding修正を完了した。初回監査はHigh 0／Medium 2／Low 1。M1（Backend異常終了と終了要求ID）、M2（Frontend初期化失敗時の終了不能）、L1（診断モードの接続先表示）は修正済みで、限定再監査はHigh 0／Medium 0／Low 0。これまでに記録されたWindows基本動作の実機確認結果を採用し、以下の自動検証結果と合わせて開発工程をクローズする。この完了記録の作成にあたり、新たな動的確認や障害注入は行っていない。記載する手動未確認事項は保証範囲の記録であり、Phase完了の阻害条件ではない。

| 遷移・境界 | 実装と自動検証 |
| --- | --- |
| 起動 → Backend → HMAC照合 → Cookie認証 → React | `backend_process.rs` / `windows_local.py`、実WebView2のAPI・画像・別窓Cookie共有smoke |
| 初回設定 → テスト → 保存 → 再起動 | `windows_connection.py` / `WindowsConnectionSettings`、認証再実行・保存・既存終了handshakeのテスト |
| 同一接続の再保存／キー更新 | 不変設定は再起動不要、キー更新は同じprofileで再起動。Recipe・History・Queue保持と別ユーザー／別URL分離をnative fixtureで検証 |
| 通常終了／Tauri強制終了 | 自分の子PIDとJobだけを所有。正常終了とkill-on-job-close、子消滅、3191再利用をnativeテストで検証 |
| 未保存編集 → 終了 | `AnshitsuPersistence.test.tsx`で保存待ち、失敗時中止、再試行、フォーカス・ショートカット復帰。色はCSS回帰テスト |
| Export中 → 終了 → 次回復旧 | `test_windows_managed.py` / Export runtime・recoveryテストでStart抑止、永続Stop、現在項目完了、次項目非開始、登録済み項目の再処理抑止 |
| Backend異常終了 | nativeテストで固定エラー表示・画面への復帰・終了を検証。未保存編集の回収を自動成功とは扱わない |
| Backend異常終了と終了保存の競合 | Rustのpending request IDを正とし、Backend終了はGuarding状態の一致IDだけを解決。遅延closeResult／cancelイベントと重複通知を状態遷移テストで検証 |
| Frontend初期化失敗 | 未Ready初回文書は既存ManagedControlのprepare／shutdownをホストが実行。React ready失敗・bootstrap認証失敗を隔離WebView smokeで検証 |
| Ready後の再読み込み | Ready→Reloadingを区別し、終了ガード中の遷移はそのIDだけ取消。Reloading中の終了では未保存編集が失われる可能性をWindows確認ダイアログで明示し、キャンセルは継続、確認時のみBackendを正常停止。新文書のReady後は保存ガードへ戻る |
| Backend停止後に旧WebViewが残る場合 | 同じWindowsセッションの単一インスタンスMutexをBackend起動前に取得。旧WebView保持中の2つ目のTauri起動を一時LOCALAPPDATA fixtureで拒否し、Backendを生成しない |
| 環境変数診断モード | Settings metadataは保存済みdescriptorを表示せず、実際の環境変数URLとキー設定有無のみを返す。秘密値と保存先情報は返さない |
| 起動タイムアウト／ポート競合／照合不整合 | 所有子の回収と外部listener非再利用、起動ID・HMAC・Host・Origin・Cookie検証。タイムアウトはsmoke専用の0秒待ち注入で検証 |
| 資格情報不読／Immich停止 | 接続・資格情報テストで回復状態へ移行し、保存済み設定を保持。平文保存・環境変数への暗黙fallbackなし |
| SQLite不使用／再起動失敗 | 初回起動の新スキーマDB・実writer lock、設定変更後の起動失敗をnativeテストで注入。選択済みDB／Recipe／Queue／資格情報を保全し、別のunconfigured DBでSettingsを表示 |
| JSON保存 | 実WebView2の3形式を一時フォルダーへ保存し、再読込みしたUTF-8バイト列と元BlobのSHA-256一致を検証。キャンセルと実書き込み失敗時のUIも検証 |

保存処理は`report_download.rs`のWebViewイベントだけで処理します。検証済みOriginの`/developer`、main／diagnosticsウィンドウ、同OriginのBlob、既知JSONファイル名に限定します。Chromiumの連続自動ダウンロード許可も同画面に限定し、各ファイルの検証と保存先選択を省略しません。ローカルHTTPクライアント向け保存APIや任意パス指定IPC、包括的filesystem権限はありません。通常ビルドはsmoke用保存先指定を含みません。

Tauriの名前付きMutexは通常のUI／manual起動でプロセス終了まで保持します。これにより、Backendだけが予期せず停止して旧WebViewが生きている間、同じWebView2 user-data directoryとCookie originを使う2個目のホストはBackendを起動する前に拒否されます。`--check-backend`とBackend単体の`--process-smoke`はUIホストではないためロック対象外です。初回Frontend未準備ではReact rootを`inert`に保ち、暗室が編集可能になる前にBackendの`prepare`／`shutdown`でExport停止と処理中項目の完了を待って終了できます。一度Readyになった後のReloading中に閉じる場合は、未保存内容を失う可能性を示すネイティブ確認を出します。キャンセル時は開いたままにし、確認時だけReact保存ガードを使わずにBackendの正常終了を待ちます。新しい文書がReadyになった後は通常の保存ガードへ戻ります。

初回横断監査でのM1・M2・L1はすべて修正済みであり、上表の自動テストで状態遷移を再確認した。Phase 2Cの既報結果はBackend全体1213件＋326 subtests、managed／recovery関連61件、Frontend関連121件および終了保存・Settings・Developer関連144件、Rust／WebView2 native 14件の成功。今回の限定修正後はRust17件、Backend接続・managed・export関連115件、Frontend persistence／History／lifecycle関連182件、初回Frontend未準備・旧WebView隔離smoke3件が成功した。TypeScript／Vite build、Clippy、Rust fmt、通常／smoke Cargo build、`git diff --check`も成功した。最初のFrontend全体並列実行で発生した2件のタイムアウトは関連単独実行で成功し、閾値は変更していない。Node環境のWebGPU skip、既存Vite 500 kB chunk警告、Cargo incremental hard-link不可によるcopy警告は既知の検証環境上の事項として記録する。

以下は未実施または直接保証していない事項であり、検証済みとは扱わない。開発工程の完了判定はこれらを必須条件とせず、必要になった段階で再評価する。

- 未保存編集を含む終了操作の最終実機確認、再読み込み中のWindows確認ダイアログの手動操作、保存失敗の実機障害注入。
- Export実行中の終了操作の最終実機確認、Windowsログオフ／シャットダウン通知への応答。
- 旧WebViewから、後から起動した別BackendへのCookie送信の直接試験。隔離テストでは名前付きMutexが二つ目のTauri／Backend起動を拒否し、その接続経路を成立させないことを確認した。
- 可視保存ダイアログの操作、日本語パス・上書き確認、OS実キー／IME、DnD、DPI、全画面、最小化復帰、実写真WebGPU／Export。実Immichへの書き込みを伴う試験は自動実行していない。
- Docker release Smoke TestとNASデプロイ検証。

既知の共通Export課題として、外部ライブラリ由来のシングル素材をExportした場合、出力JPEGのSTACK COVER設定またはGallery表示が期待と異なる問題がWindows版・Docker版の双方で確認されている。一方、Immichライブラリ内のシングル素材はDocker版で正常にCOVER設定されることが確認済み。この問題は共通Export処理の別課題として扱い、今回のPhase 1・2完了判定およびFinding件数には含めない。

Backendが失われた状態で暗室保存は成功しません。ウィンドウに編集が残っている間は、強制終了で未保存内容が失われる点に注意してください。DBを開けない回復画面では元DBの修復・ロック解除・対応版への復帰後に再起動を再試行します。Pythonや保存ルート自体が使用不能なら回復Backendも起動できないため、ウィンドウ外で原因を解消して再起動します。資格情報削除・DB初期化を自動復旧手段には使いません。
