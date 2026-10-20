# LightCraft Windows/Linux PoC結果

収録日：2026-10-20。基準：LightCraft v0.9.1 / `4f0b110bcbd2e350c6d97b47f1d824c2222295c4`。
元資料と証拠区分は[資料索引](README.md)を参照。以下の元資料由来の節番号・ソース行番号は元調査のものを維持している。

以下は元資料Aから引き継いだ既存の検証履歴・実測値。今回の収録作業ではログや画像の再測定をしていない。ソース調査・設計提案は別文書を参照。

## 検証履歴と実測結果

### v0.8.0 Windows Release CLI

Releaseビルドは成功。`output/build.log`の成功記録はrelease profile 4分55秒。ログにはそれ以前のoffline依存取得失敗（`backtrace v0.3.76`が未キャッシュ）も含まれる。MSVC Developer Command PromptはVS 2022 17.14.42、x64環境を初期化していた。

Pixelの初期DNGについて、4080×3072・約14.8 MiBは当時のユーザー申告値。保存された`render.log`では同じ入力パス `I:\code\raw-test\pixel\sample.dng` から3条件を処理し、すべて1106×830で終了コード0。現在同パスのファイルは4,557,556 bytes（約4.35 MiB）で、当時の14.8 MiB申告とサイズが異なる。render.logに入力hashがないため、当時と現在のファイル同一性は確定できず、4080×3072もこの現在ファイルのタグ値としては再検証していない。

| 入力 | 条件 | 出力寸法 | JPEG bytes | 処理時間 | 結果 |
|---|---|---:|---:|---:|---|
| Pixel `sample.dng` | default | 1106×830 | 212,303 | 227 ms | 成功 |
| Pixel `sample.dng` | Exposure +1 EV | 1106×830 | 267,125 | 209 ms | 成功 |
| Pixel `sample.dng` | Exposure -1 EV | 1106×830 | 160,866 | 209 ms | 成功 |
| Pentax `sample.DNG` | default | 5472×3648 | 6,765,553 | 2,052 ms | 成功 |
| Pentax `sample.DNG` | Exposure +1 EV | 5472×3648 | 8,471,641 | 2,027 ms | 成功 |
| Pentax `sample.DNG` | Exposure -1 EV | 5472×3648 | 4,558,849 | 2,025 ms | 成功 |

出力は`I:\code\raw-test\output\pixel-*.jpg`、`pentax-*.jpg`。コマンドは`--quality 92`と`--set light.exposure=±1.0`を使用。各実行のstderrには書き出し寸法が記録されている。

### Pixel標準撮影 `sample2.dng` のv0.8.0 PoC

入力サイズは現在のファイルで16,422,322 bytes。Pixel参考JPEG `I:\code\raw-test\pixel\sample.jpg` は比較用であり、現像入力に使用していない。

| 条件 | JPEG | 寸法 | bytes |
|---|---|---:|---:|
| default | `output\pixel2-default.jpg` | 4064×3056 | 3,227,730 |
| Exposure +1 EV | `output\pixel2-plus1ev.jpg` | 4064×3056 | 3,767,896 |
| Exposure -1 EV | `output\pixel2-minus1ev.jpg` | 4064×3056 | 2,403,205 |

3条件の個別処理時間は保存ログから確認できない。以前の会話記録にある旧版デフォルト時間は1,396 msだが、個別レンダーログは残っていない。RAW IFD、ActiveArea、DefaultCrop、OpcodeList、埋め込みpreviewのタグ値を示す再利用可能な抽出結果も残っていない。

### v0.9.1 Windows Release CLI

v0.9.1をWindowsでReleaseビルドし、Pixel `sample2.dng`とPentax `sample.DNG`のデフォルト現像を実施。以前の会話記録上の単発処理時間はPixel 1,573 ms、Pentax 1,993 ms。Pixel出力は4064×3056、Pentaxは5472×3648。

| 入力 | JPEG | bytes | SHA-256 |
|---|---|---:|---|
| Pixel `sample2.dng` | `output\pixel2-default-v0.9.1.jpg` | 3,227,730 | `B660D46901D8762A914217C4E15F70C343A0C0ABC549F7F194555E4B9373B1C4` |
| Pentax `sample.DNG` | `output\pentax-default-v0.9.1.jpg` | 6,765,553 | `575AEFEF31B714ACAD983BB9A5C27524A46FEE9E2E9C9B35FEC35D41BC68A619` |

各SHA-256はv0.8.0のWindowsデフォルトJPEGと一致した。時間は会話に記録された単発値で、ベンチマーク統計ではない。

### v0.9.1 Linux Docker CPU PoC

Windows Docker Desktop Linux Engine上で、既存のmulti-stage Dockerfileを使い`linux/amd64`イメージをビルド。Rust 1.99.1、`cargo build --release --locked --no-default-features -p lightcraft-cli`。ReleaseビルドのCargo時間は2分48秒。ビルド時にcraft-fonts未設定（CJK文字表示）の警告1件。現像実行時の警告・エラーなし。イメージ内CLIは`lightcraft-cli 0.9.1`。

`LIGHTCRAFT_GPU_BACKEND=off`を設定し、入力ディレクトリをDocker bind mount `:ro`で現像。GNU `/usr/bin/time -v`で壁時計時間とMaximum resident set sizeを取得。CPU-onlyはGPUを使わない意味で、CPUの並列実行は有効（Desktop上のCPU使用率は約567%／573%）。

| 入力 | Linux出力 | 寸法 | bytes | 壁時計時間 | 最大RSS | 終了 |
|---|---|---:|---:|---:|---:|---:|
| Pixel `sample2.dng` | `output\docker-v0.9.1\pixel-default-v0.9.1-linux-amd64.jpg` | 4064×3056 | 3,227,674 | 2.58 s | 1,089,004 KiB（約1.04 GiB） | 0 |
| Pentax `sample.DNG` | `output\docker-v0.9.1\pentax-default-v0.9.1-linux-amd64.jpg` | 5472×3648 | 6,765,421 | 2.88 s | 1,675,444 KiB（約1.60 GiB） | 0 |

現像ログは`I:\code\raw-test\output\docker-v0.9.1\logs\pixel-default.log`と`pentax-default.log`。

### Windows/Linux画素比較

v0.9.1 Windows版デフォルト出力とLinux版を比較。SHA-256は一致しない。寸法は一致。Windows上でJPEGをRGBへデコードして比較した集計値（8-bitチャンネル）：

| カメラ | Linux SHA-256 | Windows SHA-256 | 差分画素 | MAE | PSNR | 最大チャンネル差 |
|---|---|---|---:|---:|---:|---:|
| Pixel | `2D04F5FA47DC93333C4D663DD7B632DA1923C90AC1DA2D391CD20BBFBF06A6BE` | `B660D46901D8762A914217C4E15F70C343A0C0ABC549F7F194555E4B9373B1C4` | 25,121 / 12,419,584（0.2023%） | 0.001935 | 73.45 dB | 24 |
| Pentax | `41BA22D0E03B4509A21F075B06D2B7217142C4F902ACBCED97637465BE317215` | `575AEFEF31B714ACAD983BB9A5C27524A46FEE9E2E9C9B35FEC35D41BC68A619` | 59,147 / 19,961,856（0.2963%） | 0.003778 | 68.88 dB | 34 |

JPEG間で画素差が存在することは測定したが、差分原因（OS/CPU/SIMD/エンコーダー経路など）は切り分けていない。画面を用いた主観画質判定は未実施。

## DockerイメージとQNAP配備準備

| 項目 | 値 |
|---|---|
| Tag | `lightcraft-cli:v0.9.1-cpu` |
| Platform | `linux/amd64` |
| Image ID | `sha256:03ae53f52596dbf6b9df6b66da653280bd4b3e0d4d2b4e132022685343ec1e2` |
| Image size | 376,060,211 bytes（約359 MiB） |
| Archive | `I:\code\raw-test\docker\lightcraft-cli-v0.9.1-cpu-linux-amd64.tar` |
| Archive bytes | 379,172,352（約362 MiB） |
| Archive SHA-256 | `16CD9E4279589EFAE3DDBADD5EFA95B8F3DF056E479E81F8BBCBCAA0A573D319` |
| Metadata | `I:\code\raw-test\docker\image-metadata-v0.9.1.txt` |
| QNAP手順 | `I:\code\raw-test\docker\qnap-v0.9.1-poc.md` |
| 逐次実行script | `I:\code\raw-test\docker\run-qnap-poc.sh` |
| Checksum file | `I:\code\raw-test\docker\lightcraft-cli-v0.9.1-cpu-linux-amd64.tar.sha256` |

QNAP手順は実際の共有フォルダーパスを変数で指定する。DNG inputはread-only、JPEGとログは別のwritable mount。Pixel完了後にPentaxを開始し、同時現像しない。`/usr/bin/time -v`でElapsed timeとMaximum RSSをログへ保存する。`run-qnap-poc.sh`はPOSIX shell構文確認済み。NAS転送、`docker load`、Container Station操作、QNAP上のコンテナ実行はすべて未実施。

## 検証ファイル・ログの所在

- `I:\code\raw-test\output\build.log`: v0.8.0 Windows Release build。offline依存取得失敗と後続成功記録を含む。
- `I:\code\raw-test\output\render.log`: v0.8.0 Pixel旧sample / Pentaxの3条件CLI、出力寸法・処理時間・exit code。
- `I:\code\raw-test\output\dng-rawinfo.log`: DNG tag調査の試み。offline時`backtrace v0.3.76`取得失敗。数値RAW metadataの証跡ではない。
- `I:\code\raw-test\output\pixel2-*.jpg`: Pixel `sample2.dng` v0.8.0 3条件JPEG。
- `I:\code\raw-test\output\pixel2-default-v0.9.1.jpg`、`pentax-default-v0.9.1.jpg`: Windows v0.9.1 JPEG。
- `I:\code\raw-test\output\docker-v0.9.1\`: Linux JPEG、`logs\pixel-default.log`、`logs\pentax-default.log`。
- `I:\code\raw-test\docker\`: Dockerfile、dockerignore、README、image metadata、tar、SHA-256、QNAP guide、run script。
- Windows v0.9.1 build/timingおよびWindows/Linux画素集計の個別ログは保存されず、会話記録を転記した。
- 元入力: `I:\code\raw-test\pixel\sample2.dng`、`I:\code\raw-test\pentax\sample.DNG`、比較参照JPEG `I:\code\raw-test\pixel\sample.jpg`。参照JPEGは現像入力には使っていない。

## 未検証・残存事項

1. 初期Pixel `sample.dng`縮小のRAW IFD / ActiveArea / DefaultCrop / OpcodeList / embedded previewの数値と、1106×830を決めた正確な段階。保存済みtag dumpが失敗し、元ファイルも期待位置で再確認できない。
2. Pixel `sample2.dng`に対する個々のDNG tag値（RAW IFD/ActiveArea/DefaultCrop/opcodes）の永続的証跡。JPEG出力寸法とdecode成功は確認した。
3. QNAP TS-664実機の処理時間、最大RSS、CPUスケジューリング、memory pressure、Container Station/QuTSのbind mount ACL。DesktopでのRSSをNAS実測とみなさない。
4. GenzoRoomへのCLI service、Rust crate、React/WASMいずれの統合も未実装・未検証。上流更新追随の自動化、API互換性保証も未整備。
5. Windows/Linux JPEGの微小画素差の原因、主観画質評価、再現性を複数回測る統計性能比較。
6. AGPL-3.0-onlyアプリへの実配布形態を含む正式なライセンスレビュー。
