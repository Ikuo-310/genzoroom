# LightCraft v0.10.0 Windows RX 580 DX12 MCP実機PoC

実施日：2026-10-21（Asia/Tokyo）。対象はWindows 11上のRadeon RX 580。元の計測記録は`I:\code\raw-test\output\gpu-v0.10.0-20261021\RESULTS.md`を参照。

## 検証環境と実行条件

| 項目 | 実測・設定 |
|---|---|
| LightCraft | v0.10.0、commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c` |
| OS | Windows 11 Pro 10.0.26300 |
| GPU | AMD Radeon RX 580 Series |
| GPUドライバー | `31.0.21923.11000`（2025-07-01） |
| CPU／RAM | Ryzen 7 3700X、8 cores／16 threads／物理RAM約32 GiB |
| Rust／Cargo | rustc 1.99.1、cargo 1.99.1、`x86_64-pc-windows-msvc` |
| ビルド | `cargo build --release --locked --no-default-features -p lightcraft-cli` 成功 |
| Feature | CLI default features無効、AI denoise無効。native wgpu computeは有効 |
| 実行バイナリ | `I:\code\raw-test\lightcraft-v0.10.0-gpu-poc\target\release\lightcraft-cli.exe` |
| GPU条件 | 常駐`mcp --compact`、`LIGHTCRAFT_GPU_BACKEND=dx12` |
| CPU条件 | 別プロセスで常駐`mcp --compact`、`LIGHTCRAFT_GPU_BACKEND=off` |

GPU profiling用プロセス、GPU計時プロセス、CPU計時プロセスを分けた。計時はprofilingなしのGPU・CPUプロセスで行った。各プロセスはPixel、Pentaxの順に同じSession内で処理した。

対象RAWはPixel `I:\code\raw-test\pixel\sample2.dng`とPentax `I:\code\raw-test\pentax\sample.DNG`。Previewは長辺1024pxのPNGで初回1回と同設定3回、露光変更後は`+0.25, +0.5, +1.0, -0.5, 0 EV`の各Previewを測定した。JPEG Exportはquality 92、`longEdge: 0`（原寸）で各3回。

時間はPython `perf_counter`でMCP要求送信から応答受信までを計測し、Preview応答のPNG符号化・Base64転送、Exportの符号化・書込みを含む。露光変更後の値には直前の設定変更コマンド時間を含めない。表の継続Preview、露光Preview、Exportは複数回の中央値である。初回PreviewはGPU初期化後で、写真の現像ソースは未キャッシュだったが、OSディスクcacheを冷却した条件ではない。

## 実測時間

単位はms。初回Previewと継続Previewは別に記載する。

| 素材 | 処理 | DX12 GPU | CPU固定 |
|---|---|---:|---:|
| Pixel | Preview初回 | 896.7 | 864.2 |
| Pixel | Preview継続（同設定2回目以降） | 67.7 | 77.3 |
| Pixel | 露光変更後Preview | 67.6 | 70.7 |
| Pixel | 原寸JPEG Export | 1,131.3 | 1,356.1 |
| Pentax | Preview初回 | 599.3 | 607.9 |
| Pentax | Preview継続（同設定2回目以降） | 61.6 | 58.7 |
| Pentax | 露光変更後Preview | 62.1 | 55.9 |
| Pentax | 原寸JPEG Export | 1,436.1 | 1,842.7 |

原寸JPEG ExportはPixelで16.6%、Pentaxで22.1%短縮した。1024px PreviewのGPU優位は一貫せず、Pixelでは継続Previewが短縮した一方、PentaxではCPUが短かった。初回PreviewもGPUが一律に速い結果ではない。

`app.gpu`を初回取得したときのGPU初期化は通常GPUプロセスで約1,245.8 ms、profiling用GPUプロセスで約1,815.8 msだった。計時表のPreview値にはこの初期化時間を含めない。CPU無効設定との初期化時間比較は行っていない。

| プロセス | Peak working set | PrivateUsageの最大サンプル値 |
|---|---:|---:|
| GPU | 1,127.0 MiB | 2,939.3 MiB |
| CPU固定 | 1,504.9 MiB | 1,498.7 MiB |

working setは`GetProcessMemoryInfo`のPeakWorkingSetSize、PrivateUsageは50ms間隔のサンプリング値。GPUプロセスのPrivateUsageにはD3D12関連のcommit等が含まれ得るため、CPU heapや専用VRAMとは同一視できない。GPU総VRAMのpeakは取得していない。`library.memory`のGPU renderer buffer snapshotはPixel処理後142.1 MiB（全量がpool）、Pentax処理後0だった。これは操作後のsnapshotであり、描画中peakやGPU全体の使用量ではない。

| 素材 | 1024px PNG Preview | 原寸JPEG Export |
|---|---:|---:|
| Pixel | 1024×770 | 4064×3056 |
| Pentax | 1024×683 | 5472×3648 |

## GPU実使用と動作確認

- `app.gpu`は`Radeon RX 580 Series (Dx12)`を選択し、`available=true`、`enabled=true`、`reason=null`を返した。stderrにも`gpu: Radeon RX 580 Series (Dx12)`と出力された。
- GPU profilingではPreview、露光変更後Preview、原寸Exportで`gpu sample`、`gpu wb/nr`、`gpu planes`、`gpu masks`、`gpu finish + readback`、`gpu histogram`等の段階を確認した。GPUの利用可能表示だけでなく、現像時のGPU段階ログを確認している。
- 通常計時とprofilingの各GPU実行で`lastFallback=null`。Export応答に`gpuFallback`はなく、ログにGPU fallback、OOM、device lostの報告はなかった。
- `develop.get`で得た設定をJSONとして保存し、露光変更後に`develop.merge`で復元した。Pixel／Pentax、GPU／CPUの各実行で設定全体の復元一致を確認した。同じプロセス内の保存・復元であり、プロセス再起動をまたぐ永続化試験ではない。
- MCPプロセスはGPU profiling、通常GPU、CPU固定の3プロセスすべてexit code 0で終了した。
- Preview／JPEG計54ファイルをPillowでデコードして寸法などを検査し、代表PreviewとExportを目視した範囲では、明らかな黒化・欠落・破損・色異常は見られなかった。これは画質の網羅評価ではない。GPU／CPU間およびv0.9.1との厳密な画素比較はしていない。

## 評価と残る未検証事項

今回の2素材では、RX 580上のDX12 GPU現像が常駐headless MCPから実際に動作し、原寸JPEG Exportで16.6〜22.1%の時間短縮を確認した。1024px Previewはおおむね約56〜77 msの範囲で、CPUとの差は小さく、素材によって優劣が変わった。常駐MCPのPreview生成自体は実用性が期待できるが、GenzoRoomの暗室UIから操作した際の応答性は未検証である。

Session＋StageCacheを使うRust Adapterとの速度・応答性比較も未実施。MCPの起動・初期化を常駐化して償却する利点は見込めるが、UIの連続操作での要求集約、古いPreview結果の破棄、長時間運用時の安定性はGenzoRoom接続時に確認する。操作応答性が足りない場合はStageCacheを保持するRust Adapterを検討する。

次の開発工程ではGenzoRoom Python Backendから常駐MCPへ接続するPoCを行い、RAW読込、設定取得・変更、Preview取得、原寸Export、正常終了を通して確認する。暗室UI接続後にスライダー連続操作時の要求集約と古いPreviewの破棄を検証し、必要に応じてRust Adapterを比較する。

本PoCは2つのRAW・1台のGPU・限られた回数での測定であり、他のRAW／編集条件、統計的な性能保証、総VRAM peak、GenzoRoom統合後の操作感は対象外。旧版との厳密な画像比較も行っていない。

## 再確認用の記録

- `I:\code\raw-test\output\gpu-v0.10.0-20261021\environment.json`：環境・build条件
- 同ディレクトリの`summary.json`：入力／実行バイナリhash、計測値、終了コード、メモリ記録
- `gpu-profile\stderr.log`：GPU段階のprofiling記録
- `gpu\`、`cpu\`：MCP要求・応答、設定JSON、Preview、JPEG、各実行結果
- `image-checks.json`、`export-contact-sheet.jpg`：基本画像検査と目視用contact sheet

この文書は上記PoC記録を研究資料へ整理したもの。今回、ビルド・現像・GPU試験の再実行はしていない。
