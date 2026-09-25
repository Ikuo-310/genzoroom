# GenzoRoom デプロイノート

この文書は、検証済みのDocker環境へGenzoRoomを再デプロイするときの内部向け手順である。Portainerを使う場合の手順も含む。公開リポジトリに置くため、APIキーの実値は記載しない。

## 1. 前提

- Docker host上でDocker Composeを使用する。Portainerを使う場合はGitHub Repository Stackとしてデプロイする。
- Windows上のローカルフォルダは開発と差分確認に使う。
- 実機検証は実際のdeployment host上で行う。

ローカルで構文確認やFrontend buildが成功しても、deployment host上のDocker network、名前解決、nginx proxy、Immich APIまで動作したことにはならない。最終確認はDocker Compose（Portainerを使う場合はPortainer）でデプロイしたコンテナとブラウザから行う。

## 2. GitHub Source

PortainerのSourceとしてGitHub Repositoryを登録する。

- Repository: [https://github.com/Ikuo-310/genzoroom](https://github.com/Ikuo-310/genzoroom)
- Visibility: Public
- Authentication: 現在はなし

リポジトリをPrivateへ変更した場合は、Portainer側の認証設定を別途見直す。

## 3. Stack設定

基本設定は次のとおり。

| 項目 | 値 |
| --- | --- |
| Name | `genzoroom` |
| Build method | `Repository` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

同一Docker host上のImmichへ接続する現在の検証環境では、次も設定する。

| 項目 | 値 |
| --- | --- |
| Additional paths | `docker-compose.immich-network.yml` |

追加Composeを使うと、GenzoRoom Backendだけが指定した既存のImmich Docker networkへ参加する。Frontendは参加しない。ImmichがLAN経由またはHTTPS URL経由でBackendから到達できる環境では、Additional pathsは不要。

## 4. Environment variables

Docker Composeの環境変数または`.env`へ設定する。Portainerを使う場合はStackのEnvironment variablesへ設定する。

```env
GENZOROOM_PORT=3190
GENZOROOM_PERSIST_ROOT=/path/to/genzoroom
IMMICH_URL=<GenzoRoom Backendから到達可能なImmich URL>
IMMICH_API_KEY=<GenzoRoom用APIキー>
```

現在の実機環境では、次のImmich接続先とDocker networkを使用している。

```env
GENZOROOM_PORT=3190
IMMICH_URL=http://immich_server:2283
IMMICH_DOCKER_NETWORK=immich_immich-net
IMMICH_API_KEY=<Portainer上で設定するGenzoRoom用APIキー>
```

`immich_server` と `immich_immich-net` は現在検証したQNAP環境の具体値であり、他の環境へそのまま転用しない。実際のコンテナ名とnetwork名はDocker hostで確認する。Portainerを使う場合はそのNetworks画面でも確認できる。

APIキーの実値は環境変数として管理する。Portainer利用時はStack設定で管理する。GitHub、ドキュメント、Composeファイル、Dockerfile、スクリーンショットへ記録しない。

## 5. Immich APIキー権限

現在必要な権限は次のとおり。

- `user.read`: `GET /api/users/me` による接続確認
- `asset.read`: `POST /api/search/metadata` による最近の写真取得と `GET /api/assets/{id}` による詳細・EXIF取得
- `asset.view`: `GET /api/assets/{id}/thumbnail` によるサムネイル・preview取得

必要以上の権限は付けない。現在のJPEG補正はブラウザ内で行うため、Immichへの書き込み、アップロード、削除、編集、originalダウンロード用の権限は不要。

## 6. 更新手順

1. Windows上でCodexなどを使って開発する。
2. VS Codeで変更ファイルと差分を確認する。
3. 自分でcommitする。
4. 自分でGitHubへpushする。
5. Portainerを使う場合は対象Stackを開き、**Pull and redeploy** を実行する。Compose利用時は最新ファイルで再build・起動する。
6. deployment host上でコンテナ状態、ログ、Web UI、Immich接続を確認する。

再デプロイ後は、ブラウザで次を確認する。

- `http://<HOST-IP>:3190` を開ける。
- `Backend: Connected` が表示される。
- `Immich: Connected` が表示される。
- 最近の写真が最大100件表示される。
- 各写真のサムネイルが表示される。
- 写真を開くとAnshitsu（暗室）へ移動し、previewと取得可能なEXIFが表示される。
- 複数写真を選択して暗室へ入り、Filmstripで切り替えると対象写真のpreview・ファイル名・EXIFへ更新される。
- JPEGの3WAY Color Gradingで各Temperature / Tintとrange ON/OFF、全体OFF→ON後の状態保持、Reset、Undo / Redoを確認する。Workerでのpreview更新とFilmstrip切替後の編集状態も確認する。

previewはImmich生成画像をBackend経由で表示する。originalやRAW現像結果ではなく、JPEG補正もこのpreviewを暫定入力としている。これらは再デプロイ時の確認項目であり、この文書の更新だけで実機検証済みとは扱わない。

Portainerで再デプロイした直後は、コンテナのbuildと起動が完了してから確認する。問題がある場合は、ブラウザ表示だけで判断せずContainer Logsを確認する。

## 7. トラブルシュート

### BackendがConnection failedの場合

1. PortainerでBackend Container Logsを確認する。
2. Backendコンテナが起動状態か確認する。
3. 必要に応じてContainer Consoleを開き、接続先の名前解決やHTTP接続を確認する。
4. nginx側のログも確認し、FrontendからBackendへのproxy失敗か、BackendからImmichへの失敗かを分ける。

### `ModuleNotFoundError` が出る場合

DockerfileのCOPY対象を確認する。過去には `main.py` だけがimageへ入り、`immich.py` が欠けたため、次のエラーが発生した。

```text
ModuleNotFoundError: No module named 'immich'
```

現在のBackend Dockerfileは `COPY . .` を使い、`.dockerignore` でtests、キャッシュ、仮想環境、`.env` などを除外している。新しいPythonモジュールがbuild context内にあるか、`.dockerignore` で誤って除外されていないかも確認する。

### ImmichがConnection failedの場合

次を順に確認する。

- `IMMICH_URL` がBackendコンテナから到達可能なURLか。
- `IMMICH_API_KEY` が正しいか。
- APIキーに `user.read` があるか。
- 写真一覧だけ失敗する場合は `asset.read` があるか。
- サムネイルだけ失敗する場合は `asset.view` があるか。
- URL末尾やポートが実際のImmich構成と一致しているか。

既知のQNAP固有事例として、検証したQNAP環境ではコンテナからQNAP自身のLAN IPへの折り返し接続がTimeoutした。QNAP自身のLAN IPでImmichへ接続できない場合、Immich固有の障害と決めつけず、別のLAN機器へ接続できるかを確認する。同一Docker host上のImmichなら、共有Docker network経由の接続を確認する。

### 共有Docker networkを確認する場合

1. Portainerの **Networks** でImmichが参加している実network名を確認する。
2. Immich Serverのコンテナ名またはDocker DNSで解決できるサービス名を確認する。
3. `IMMICH_DOCKER_NETWORK` に実network名を設定する。
4. `IMMICH_URL` を `http://<Immich Server名>:2283` の形式で設定する。
5. Additional pathsに `docker-compose.immich-network.yml` が入っているか確認する。
6. 再デプロイ後、BackendだけがImmich networkへ参加していることを確認する。

このQNAP環境では次の組み合わせで接続を確認した。

```env
IMMICH_DOCKER_NETWORK=immich_immich-net
IMMICH_URL=http://immich_server:2283
```

これらの値は他の環境では異なる可能性がある。

### 最近の写真が表示されない場合

- `Immich: Connected` でも写真一覧だけ失敗する場合は、`asset.read` と `asset.view` を確認する。
- 0件表示の場合は、APIキーのユーザーから閲覧できる画像Assetがあるか確認する。
- 一覧の文字情報は出るが画像だけ出ない場合は、サムネイルAPIの権限とBackend Logsを確認する。
- RAWとJPEG / HEICは別Assetとして表示される。これは第三段階時点の仕様であり、重複取得の不具合とは限らない。

## 8. 削除・復旧方針

アプリ固有設定はDocker Composeの範囲に閉じ込める。Portainerを使う場合はStackのEnvironment variablesも利用できる。Docker host OSのcron、システム設定ファイル、ネットワーク設定をGenzoRoomのために直接変更しない。

現在はBackendのSQLite用に、ホストの`/path/to/genzoroom/data`をコンテナの`/data`へbind mountする。事前にホスト側ディレクトリを作り、BackendのUID/GID `10001:10001`が書き込める権限を設定する。Composeは存在しないホスト側ディレクトリをroot権限で自動作成しない。dataを別ストレージに置く場合は環境変数`GENZOROOM_DATA_PATH`を指定する（Portainer利用時はStack環境変数）。SQLiteのWAL/SHMも同じ場所にできるためDBファイル単体はmountしない。暗室でJPEG写真を開くと通常は保存済み編集状態を取得する。編集後5秒間操作がなければ非圧縮Historyでautosaveし、dirtyな写真からFilmstripで移る前にも保存する。Home操作で暗室を退出すると、このセッション中に編集した全写真を順次保存し、Historyを圧縮する。圧縮に失敗した場合は非圧縮stateで保存する。最終保存に失敗すると暗室に留まるか、保存せず退出するか選べる。Browser Back、ページ再読み込み、タブ・ブラウザ終了では強制保存されず、debounce中や保存処理中の編集が失われる可能性がある。

Stack削除後もホスト側dataは残る。バックアップはBackend停止後にdataディレクトリ全体をコピーする。稼働中の`genzoroom.db`単体コピーは避ける。

Containerの削除とdataディレクトリの削除を明確に分ける。復旧に必要なデータを確認せずdataを削除しない。
