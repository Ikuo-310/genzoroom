# Windows Tauri 2 起動PoC（Phase 1B）

既存React UIをTauri 2 / WebView2で表示する互換性確認用ホストです。Backendは引き続き手動起動します。Python同梱、インストーラー、資格情報ストア、LightCraft、RAW現像は含みません。

## 前提

- Phase 1Aの[Windowsローカル起動環境](windows-local-poc.md)。Python 3.14仮想環境とFrontend依存関係を準備します。
- Rust stable（MSVCターゲット）、Visual StudioのC++ビルドツール、Windows SDK、WebView2 Runtime。Tauriの[Windows prerequisites](https://v2.tauri.app/start/prerequisites/)に従います。
- Tauri CLIや追加のNode UIフレームワークは不要です。Cargo.lockで固定した依存関係を使います。

## 起動

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
cargo run --manifest-path desktop/Cargo.toml --locked
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

保存先はPhase 1Aと同じです。WebView2の専用プロファイルを`%LOCALAPPDATA%\GenzoRoom\WindowsPoC\webview2`に追加します。通常ブラウザーとはCookie・UI設定が別になります。ポートを変えるとオリジン単位のUI設定も変わります。

## 認証情報の受け渡し

Phase 1Aの起動用URLは通常ブラウザーへ直接渡す方式で、Tauriが安全に取得する経路がありませんでした。`--desktop`を明示した場合だけ、Backendのstartup完了後に次を追加します。

1. `%LOCALAPPDATA%\GenzoRoom\WindowsPoC\desktop-session.dpapi`へ、Windowsのユーザー単位DPAPIで暗号化した一時情報を原子的に書き込みます。ポート・一回限りのbootstrap token・インスタンス照合用キーだけを含み、Immich APIキーやCookieは含みません。平文の一時ファイルは作りません。
2. Tauriは同じWindowsユーザーで復号し、ランダムchallengeへのHMAC応答を`/__local/desktop-ready`で検証します。照合用キーもbootstrap tokenもこのリクエストには送信しません。HTTPクライアントはプロキシ・リダイレクトを使用しません。
3. 検証成功後にだけWebView2へbootstrap URLを渡します。フラグメント除去、同一OriginのPOST、HttpOnly・SameSite=Strict CookieはPhase 1Aの既存経路です。Cookieをネイティブコードから注入しません。

通常終了時に自分が作成した暗号化情報を削除します。強制終了で残っても、次回は新しい起動情報で置換され、停止したBackendや別インスタンスの応答では照合に成功しません。平文URL・キー・Cookieをログやコマンド引数に出力しません。

Tauri capabilitiesは空で、リモートページにShell・Filesystem・HTTPプラグイン等の権限を付与していません。ReactからRustの独自コマンドを呼ぶ構成でもありません。DPAPIも同じユーザー権限の悪意あるプロセスから秘密を隔離するものではありません。

## 停止

暗室の編集を保存し、実行中ExportはUIのCancel後に現在項目の完了を待ちます。Tauriウィンドウを閉じた後、ターミナルAでCtrl+Cを一度押してBackend終了を待ちます。ウィンドウを閉じてもBackendは停止せず、終了前保存も自動実行しません。Export復旧動作と強制終了時の制限は[Phase 1Aの手順](windows-local-poc.md#停止とexport)と同じです。

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
    & '..\.venv\Scripts\python.exe' -m pytest tests/test_windows_local.py -k 'windows_cli_build_startup_and_graceful_shutdown and desktop' -q -s
} finally {
    Remove-Item Env:GENZOROOM_WEBVIEW_SMOKE
}
```

このスモークは正規認証、React表示、APIエラーのJSON応答、画像URLからのJPEG／Canvas読み取り、Diagnostics別窓のCookie共有、既存WebGPU診断の実行を確認します。GPUがない環境では`gpuResults: false`も想定されるため、GPU描画の合否は出力を区別してください。手操作や実Immich写真の画質・速度を保証する検証ではありません。

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
| 終了・再起動 | 編集保存、Export Cancel、Tauri終了とBackend停止の分離、新しい認証での再起動 |

自動スモークで成立した項目と、この表の人による実機確認は区別して記録してください。
