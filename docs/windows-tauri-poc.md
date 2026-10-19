# Windows Tauri 2 起動PoC（Phase 2B）

既存React UIをTauri 2 / WebView2で表示するWindows開発用ホストです。通常起動ではリポジトリの`.venv`を使ってBackendを自動起動し、終了も管理します。Immich接続はSettingsで登録し、APIキーはWindows資格情報マネージャーへ保存します。Python同梱、インストーラー、LightCraft、RAW現像は含みません。

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
- 保存後に新Backendを起動できなかった場合は、接続未設定の回復Backendを起動します。保存済み設定と以前のprofileは保持し、Settingsで修正・新規登録または再起動再試行できます。保存先DBの破損や新しいスキーマ等が原因なら、そのファイルを保全してから設定を再保存すると空のprofileで復帰できます。回復Backendも起動できない場合は表示されたエラーを確認し、ポート競合・Python環境・保存先アクセスを解消してTauriを再起動してください。
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
- DiagnosticsのJSONダウンロードは既存のブラウザー経路です。保存ダイアログ／保存先は実機確認対象です。

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
