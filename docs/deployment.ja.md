# GenzoRoom 導入ガイド

[English](deployment.md) | 日本語

このガイドでは、GitHub Container Registry(GHCR)で公開されているGenzoRoomの正式版Dockerイメージを使用した導入方法を説明します。

GenzoRoomは単一コンテナで動作し、Docker Composeを使って導入できます。

## 必要条件

- Docker Engine / Docker Compose v2
- Linux amd64(x86-64)のDockerホスト
- GenzoRoomコンテナから接続可能なImmichサーバー
- 必要な権限を設定したImmich APIキー
- GenzoRoomにアクセスするためのWebブラウザー

現在、Arm64環境は動作確認・サポート対象外です。

## Immich APIキー

Immichにログインし、「アカウント設定」→「APIキー」からGenzoRoom専用のAPIキーを作成してください。  
作成時には、以下のアクセス権限を設定してください。

| 権限 | 用途 |
| --- | --- |
| `user.read` | 接続認証の確認 |
| `asset.read` | 写真情報の取得 |
| `asset.view` | サムネイル・プレビュー表示 |
| `asset.download` | JPEGオリジナルの取得 |
| `asset.upload` | 現像済みJPEGの登録 |
| `asset.delete` | 確認済みのゴミ箱移動 |
| `album.read` | アルバムの閲覧・出力元の所属アルバム取得 |
| `albumAsset.create` | 現像済みJPEGを出力元の所属アルバムへ追加 |
| `tag.read` | タグ情報の取得 |
| `tag.create` | GenzoRoomタグの作成 |
| `tag.asset` | 写真へのタグ設定・修復 |
| `stack.read` | STACK情報の取得 |
| `stack.create` | STACKの作成 |
| `stack.update` | STACKの更新 |
| `stack.delete` | STACKの解除・削除 |

`server.about` は任意です。許可すると、設定画面などでImmichのバージョン情報を表示できます。

出力には、設定したユーザーが元写真の各アルバムを所有しているか、編集者権限を持っている必要があります。アルバム所属の継承に失敗するとSTACK化前に出力を停止します。アップロード済みのJPEGは残る場合があり、再試行で利用します。

GenzoRoomが行うゴミ箱移動は、Immichの通常のゴミ箱機能を使用します。写真の完全削除は行いません。

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `IMMICH_URL` | GenzoRoomコンテナからアクセスできるImmichのURL |
| `IMMICH_API_KEY` | GenzoRoom専用のImmich APIキー |
| `GENZOROOM_PERSIST_ROOT` | 編集データを保存するホスト側ディレクトリ |
| `GENZOROOM_IMAGE_TAG` | 使用するDockerイメージのタグ。通常は `latest` |
| `GENZOROOM_PORT` | ホスト側の公開ポート。標準は `3190` |

設定例：

```env
GENZOROOM_IMAGE_TAG=latest
GENZOROOM_PORT=3190
GENZOROOM_PERSIST_ROOT=/path/to/genzoroom

IMMICH_URL=http://immich-server:2283
IMMICH_API_KEY=your-immich-api-key
```

`IMMICH_URL` と `GENZOROOM_PERSIST_ROOT` は利用環境に合わせて変更してください。

## 永続化データ

GenzoRoomは、編集レシピ、History、出力キュー、出力処理の状態をSQLiteに保存します。

コンテナ内の保存先は以下のとおりです。

```text
/genzoroom/data/genzoroom.db
```

Dockerでは `/genzoroom` をホスト側のディレクトリへbind mountしてください。

```yaml
volumes:
  - type: bind
    source: ${GENZOROOM_PERSIST_ROOT}
    target: /genzoroom
    bind:
      create_host_path: false
```

ホスト側のディレクトリは事前に作成し、コンテナ内のUID/GID `10001:10001` が書き込みできるようにしてください。

新規導入時はGenzoRoomが `data` ディレクトリとデータベースを作成します。

既存のインストールを更新する場合は、同じ保存先を使用してください。別の空ディレクトリを指定すると、新規環境として起動する可能性があります。

同じデータベースを複数のGenzoRoomコンテナから同時に使用しないでください。

## Immichへの接続

`IMMICH_URL` には、GenzoRoomコンテナからアクセスできるImmichサーバーのURLを指定します。

LAN内のアドレス、HTTPSのURL、同じDockerネットワーク上のサービス名など、利用環境に応じて設定してください。

同じDockerネットワーク上のImmichへ接続する場合は、必要に応じてGenzoRoomをそのネットワークに参加させてください。

## Docker Composeによる導入

### 1. 設定ファイルの準備

リポジトリから以下のファイルを取得します。

- [compose.release.yml](../compose.release.yml)
- [.env.example](../.env.example)

`.env.example` を `.env` として用意し、Immichの接続情報、イメージタグ、データの保存先などを設定してください。

保存先ディレクトリの作成とアクセス権限の設定も済ませてください。

### 2. コンテナの起動

設定ファイルのあるディレクトリで実行します。

```sh
docker compose -f compose.release.yml config --quiet
docker compose -f compose.release.yml pull
docker compose -f compose.release.yml up -d
```

### 3. ブラウザーからアクセス

標準設定では、以下のアドレスにアクセスします。

```text
http://<ホストIP>:3190
```

公開ポートを変更した場合は、そのポートを指定してください。

GenzoRoomの設定画面で、BackendとImmichの接続状態を確認できます。

## 更新とバックアップ

GenzoRoomの編集レシピや出力キューなどは、永続化ディレクトリに保存されています。

更新する場合は、出力処理が終了していることと、編集中の変更が保存されていることを確認してください。

**バックアップ時はコンテナを停止し、ホスト側の `data` ディレクトリ全体をコピーしてください。**

SQLiteはWALモードを使用するため、`genzoroom.db` 単体ではなく、関連するWAL/SHMファイルも含めて保存します。

更新時には同じ永続化ディレクトリを使用します。コンテナを再作成しても、保存先が維持されていれば編集データを引き続き利用できます。

以前のバージョンへ戻す場合は、データベースの互換性に注意してください。必要に応じて更新前のバックアップを復元してください。

## 動作確認

導入後は、以下の動作を確認してください。

1. GenzoRoomの画面が表示される。
2. BackendとImmichの接続状態が正常である。
3. ギャラリーにImmichの写真とサムネイルが表示される。
4. JPEG写真を暗室で開いて編集できる。
5. 編集内容が保存され、再度開いた際に復元される。

接続確認用のAPIも利用できます。

```text
http://<ホストIP>:3190/api/health
http://<ホストIP>:3190/api/immich/status
```

## トラブルシューティング

### Immichに接続できない

`IMMICH_URL` がGenzoRoomコンテナからアクセス可能か確認してください。

あわせて、`IMMICH_API_KEY` の値と必要な権限、Dockerネットワークの設定を確認してください。

### 写真が表示されない

Immichとの接続が正常でも写真が取得できない場合は、`asset.read`、`asset.view` などのAPI権限を確認してください。

STACK管理や出力機能で問題がある場合は、対応する `stack.*`、`asset.upload`、`tag.*` などの権限も確認してください。

### データベースを使用できない

`GENZOROOM_PERSIST_ROOT` の指定先、bind mount、UID/GID `10001:10001` のアクセス権限を確認してください。

既存データを使用する場合は、正しい `data/genzoroom.db` が参照されていることも確認してください。

### WebGPUを利用できない

WebGPUには対応するGPU、ドライバー、ブラウザーとセキュアコンテキストが必要です。

通常はHTTPSまたはlocalhostで利用できます。LAN内のHTTP接続でも、ブラウザーの開発者向け設定で例外を登録すると利用できる場合があります。

WebGPUを利用できない場合もCPUで編集できます。

## 停止・削除

コンテナを停止・削除する場合は、以下のコマンドを使用します。

```sh
docker compose -f compose.release.yml down
```

bind mountしているホスト側のデータは残ります。

GenzoRoomの編集履歴や出力キューも削除する場合は、必要なバックアップを取得したうえで、ホスト側の保存ディレクトリを別途削除してください。

---

GenzoRoomの機能については[README](../README.ja.md)を参照してください。
