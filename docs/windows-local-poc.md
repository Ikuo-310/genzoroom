# Windows ローカル起動 PoC（Phase 1A）

既存React UIとFastAPIをWindows PCで実行する開発用の起動方法です。Tauri、Python同梱、インストーラー、LightCraft、RAW現像は含みません。Docker版のCompose・nginx・起動入口は従来どおりです。

## 前提

- Windows、リポジトリのPython 3.14仮想環境（`.venv`）、既存のBackend依存関係。
- Frontendの依存関係とNode.js（`frontend/package.json`の要件に従う）。
- 既定ブラウザーを設定しておくこと。初回認証のため、起動成功後にブラウザーが自動で開きます。
- Windowsからアクセス可能なImmichのURLとAPIキー。NASのコンテナや設定は変更しません。

## ビルドと起動

PowerShellでリポジトリのルートから実行します。

```powershell
Set-Location I:\code\genzoroom\frontend
# node_modulesが未準備の場合のみ npm ci
npm run build

Set-Location I:\code\genzoroom\backend
$env:IMMICH_URL = 'https://your-immich.example'
# キーをコマンド履歴に直接残さない。Backendにはこのプロセスの環境変数で渡す。
$immichKeyInput = Read-Host 'Immich API key' -AsSecureString
$env:IMMICH_API_KEY = [System.Net.NetworkCredential]::new('', $immichKeyInput).Password
try {
    & '..\.venv\Scripts\python.exe' windows_local.py
} finally {
    Remove-Item Env:IMMICH_API_KEY -ErrorAction SilentlyContinue
    Remove-Variable immichKeyInput -ErrorAction SilentlyContinue
}
```

URL・APIキーは起動時の環境変数を使用します。設定画面からの保存・切替はありません。変更する場合は停止して再起動してください。接続先や利用者を切り替えて同じPoCデータを使い回さないでください。接続プロファイルの分離は次フェーズです。

未設定でもローカルBackendとUIは起動し、接続情報にImmich未設定と表示されます。

既定ポートは`3191`、バインド先は`127.0.0.1`のみです。起動直後に表示される通常URLを手動で開くだけでは認証されません。自動で開く一回限りの起動用URLで認証し、その後は同じブラウザープロファイルで通常URLや`/anshitsu/<Asset ID>`を直接開けます。起動用URLは共有・記録しないでください。再起動すると以前の認証Cookieは無効になります。

ポート競合時は`local_port_unavailable`で終了し、別ポートへ自動変更しません。必要な場合だけ`--port 3192`のように明示指定できます。ただしブラウザーのUI設定はポートごとに別領域になります。同じ保存領域を複数Backendで同時に使わないでください。

`--no-browser`は自動起動チェック用です。認証URLを表示・ファイル保存しないため、このオプションでは通常の対話利用を開始できません。

## 保存先

```text
%LOCALAPPDATA%\GenzoRoom\WindowsPoC\
  data\genzoroom.db
  cache\thumbnails\
```

初回は新しい空のDBを作成します。Dockerの`/genzoroom`、`GENZOROOM_PERSIST_ROOT`、既存DBは使用・コピーしません。以後の起動ではPoC用DBを再利用し、既存のExport復旧処理を実行します。DB形式・Recipe・History・Queueの仕様は変更していません。

SQLiteのWAL/SHMも同じdataディレクトリに作成されます。稼働中のDBファイルだけをコピー・移動・削除しないでください。`LOCALAPPDATA`が未設定、相対パス、UNC共有の場合は起動を拒否します。

## 停止とExport

1. 暗室からHomeへ戻り、保存完了を確認します。ブラウザーを閉じるだけではBackend停止や終了前保存は行いません。
2. Export実行中は、UIでCancelを実行し、現在項目が終了して実行状態が停止するまで待ちます。残りの項目は既存仕様に従ってQueueに残ります。
3. 起動したPowerShellでCtrl+Cを一度押し、Python終了まで待ちます。

Ctrl+CだけではExportの停止要求を記録しません。既存Backendのlifespanは`ExportRuntime.wait()`で実行中のrunを待つため、先にCancelしない場合は残り全件の処理終了まで待つ可能性があります。サムネイルは実行中の1件を待ち、未実行予約は破棄します。

二度目のCtrl+C、ターミナル強制終了、タスク終了は正常停止ではありません。DBに残ったExport実行状態は次回起動時に既存処理で復旧され、未完了項目が再生成・再登録される場合があります。未保存のブラウザー内編集は復旧保証の対象外です。

## ローカルHTTPの保護

- 起動ごとのランダム値を、HTTPへ送信されないURLフラグメントで初期画面へ渡します。画面はフラグメントを履歴から除去し、同一OriginのJSON POSTで一度だけ交換します。
- 以後は起動ごとのHttpOnly・SameSite=Strict Cookieを使用し、API・画像・静的UIを同じ認証で保護します。Reactの画像URLに認証ヘッダーを追加する必要はありません。
- Hostは`127.0.0.1:<port>`、Originがある場合はそのOriginだけを許可します。ブラウザーのcross-site/same-site別オリジン要求も拒否します。
- `/api`は既存FastAPIへ先にルーティングします。未知のAPI・API検証エラーはHTMLへ変換しません。SPAへのHTMLナビゲーションだけにフォールバックします。
- HTTPアクセスログは無効です。診断ログへAPIキー、Cookie、起動用URL、認証値を記録しません。

これはWindows資格情報ストアを使う製品版ではありません。APIキーはBackendの環境変数・メモリに存在し、ローカルCookieもHTTP用です。同じユーザー権限の悪意あるプロセスから秘密を隔離する仕組みではありません。

## 確認項目

自動テストはローカルHTTP起動、保存領域、Cookie認証、Host/Origin拒否、APIとSPAの分離、画像のCookie取得、既存保存・Queue機能を確認します。

利用者による実機確認では、Galleryの一覧・画像、STACKのドラッグ・編集、暗室のJPEG Preview／Original、Slider・ショートカット・Filmstrip、保存後の再起動、Export Cancelを確認してください。実Immichへの書込みは専用テスト素材で実施してください。自動テスト成功は、NAS実接続やブラウザー上の操作確認を意味しません。
