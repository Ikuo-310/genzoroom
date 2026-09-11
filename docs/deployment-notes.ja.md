# GenzoRoom デプロイノート

この文書は、現在のQNAP / Portainer環境へGenzoRoomを再デプロイするときの内部向け手順である。公開リポジトリに置くため、APIキーの実値は記載しない。

## 1. 前提

- NASはQNAPを使用する。
- DockerとPortainerを使用する。
- GitHub RepositoryからPortainer Stackとしてデプロイする。
- Windows上のローカルフォルダは開発と差分確認に使う。
- 正式な実機検証はNAS上で行う。

ローカルで構文確認やFrontend buildが成功しても、NAS上のDocker network、名前解決、nginx proxy、Immich APIまで動作したことにはならない。最終確認はPortainerでデプロイしたコンテナとブラウザから行う。

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

同一Dockerホスト上のImmichへ接続する現在のQNAP環境では、次も設定する。

| 項目 | 値 |
| --- | --- |
| Additional paths | `docker-compose.immich-network.yml` |

追加Composeを使うと、GenzoRoom Backendだけが指定した既存のImmich Docker networkへ参加する。Frontendは参加しない。ImmichがLAN経由またはHTTPS URL経由でBackendから到達できる環境では、Additional pathsは不要。

## 4. Environment variables

通常はPortainer StackのEnvironment variablesへ次を設定する。

```env
GENZOROOM_PORT=3190
IMMICH_URL=<GenzoRoom Backendから到達可能なImmich URL>
IMMICH_API_KEY=<GenzoRoom用APIキー>
```

同一QNAP上にある現在の実機環境では、次の接続先とnetworkを使用している。

```env
GENZOROOM_PORT=3190
IMMICH_URL=http://immich_server:2283
IMMICH_DOCKER_NETWORK=immich_immich-net
IMMICH_API_KEY=<Portainer上で設定するGenzoRoom用APIキー>
```

`immich_server` と `immich_immich-net` は現在のQNAP環境に固有の値。他の環境へそのまま転用せず、Portainerで実際のコンテナ名とnetwork名を確認する。

APIキーの実値はPortainerだけで管理する。GitHub、ドキュメント、Composeファイル、Dockerfile、スクリーンショットへ記録しない。

## 5. Immich APIキー権限

第三段階時点で必要な権限は次のとおり。

- `user.read`: `GET /api/users/me` による接続確認
- `asset.read`: `POST /api/search/metadata` による最近の写真取得
- `asset.view`: `GET /api/assets/{id}/thumbnail` によるサムネイル取得

必要以上の権限は付けない。第三段階では、書き込み、アップロード、削除、編集、ダウンロード用の権限は不要。

## 6. 更新手順

1. Windows上でCodexなどを使って開発する。
2. VS Codeで変更ファイルと差分を確認する。
3. 自分でcommitする。
4. 自分でGitHubへpushする。
5. Portainerで対象Stackを開き、**Pull and redeploy** を実行する。
6. NAS上でコンテナ状態、ログ、Web UI、Immich接続を確認する。

第三段階では、ブラウザで次を確認する。

- `http://<NAS-IP>:3190` を開ける。
- `Backend: Connected` が表示される。
- `Immich: Connected` が表示される。
- 最近の写真が最大50件表示される。
- 各写真のサムネイルが表示される。

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

現在のQNAP環境では、コンテナからQNAP自身のLAN IPへの折り返し接続がTimeoutした。QNAP自身のLAN IPでImmichへ接続できない場合、Immich固有の障害と決めつけず、別のLAN機器へ接続できるかを確認する。同一Dockerホスト上のImmichなら、共有Docker network経由の接続を確認する。

### 共有Docker networkを確認する場合

1. Portainerの **Networks** でImmichが参加している実network名を確認する。
2. Immich Serverのコンテナ名またはDocker DNSで解決できるサービス名を確認する。
3. `IMMICH_DOCKER_NETWORK` に実network名を設定する。
4. `IMMICH_URL` を `http://<Immich Server名>:2283` の形式で設定する。
5. Additional pathsに `docker-compose.immich-network.yml` が入っているか確認する。
6. 再デプロイ後、BackendだけがImmich networkへ参加していることを確認する。

現在のQNAP環境では次の組み合わせで接続できている。

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

アプリ固有設定はPortainer Stack、Environment variables、Docker Composeの範囲に閉じ込める。NASホストOSのcron、システム設定ファイル、ネットワーク設定をGenzoRoomのために直接変更しない。

第三段階時点では、GenzoRoomは大きな永続データやアプリ用Volumeを持っていない。Stackを削除しても、GitHubリポジトリやImmich内の写真は削除されない。ローカルに残るDocker imageなどは必要に応じて別途管理する。

将来、非破壊編集パラメータやキャッシュをVolumeへ保存する段階になったら、Containerの削除とVolumeの削除を明確に分ける。復旧に必要なデータを確認せずVolumeを削除しない運用にする。
