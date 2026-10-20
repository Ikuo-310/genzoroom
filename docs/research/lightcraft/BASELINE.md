# LightCraft 基準・構成・ライセンス

ここに記載する構成・API・ライセンス表記はソース調査上の事実。ビルド環境の使用履歴は元資料Aの記録であり、今回のビルド結果ではない。法的適合性の審査結果ではない。

収録日：2026-10-20。基準：LightCraft v0.9.1 / `4f0b110bcbd2e350c6d97b47f1d824c2222295c4`。
元資料と証拠区分は[資料索引](README.md)を参照。以下の元資料由来の節番号・ソース行番号は元調査のものを維持している。

## バージョン・基準commit

| 対象 | バージョン | commit | 確認 |
|---|---|---|---|
| 比較基準 | 0.8.0 | `f34c7a8a89e0d1bade0a6889185f40acecc84a9f` | `Cargo.toml`のworkspace versionが0.8.0。2026-10-15のcommit |
| Docker/更新検証 | v0.9.1 | `4f0b110bcbd2e350c6d97b47f1d824c2222295c4` | 指定タグとcommitの一致を確認。`Cargo.toml` version 0.9.1。2026-10-17のrelease commit |
| 現在のcheckout | v0.9.1 | `4f0b110bcbd2e350c6d97b47f1d824c2222295c4` | detached HEAD、作業ツリーclean |

Rust/Cargo 1.99.1をWindowsで使用。Dockerビルダーも公式 `rust:1.99.1-bookworm`。LightCraftのworkspace `rust-version`は1.90。

## crate・CLI・WASMの構成

- Workspace version/licensing: `Cargo.toml`。主要crateのレイヤー概要は`AGENTS.md`のMap、`docs/architecture.md`。
- RAW DNG: `crates/raw/src/dng.rs::decode`、共通入口`crates/raw/src/lib.rs::decode`。展開後の処理は`RawImage::normalized`、`RawImage::develop`、`RawImage::develop_crop`。
- 画像import/preview: `crates/engine/src/files.rs::probe_bytes`、`load_bytes`、`load_bytes_now`。
- 現像pipeline: `crates/pipeline/src/lib.rs::render` / `render_cached`。
- 統一export: `crates/engine/src/export.rs::export_photo`。CLI、UI等で共有される。
- Headless CLI: `apps/lightcraft-cli/src/main.rs::render`。`Session`へ`library.import`、`library.select`、設定反映をdispatchし、engine exportへ進む。画面の起動は不要。
- GUI/Web: `apps/lightcraft`（desktop）、`apps/lightcraft-web`（egui WASM UI）。Web用crateは`cdylib`を作るが、独立したReact向けRAW renderer packageとしては提供されていない。

## Linux/Docker・WASM・ライセンス

- Dockerfileは`I:\code\raw-test\docker\Dockerfile`。multi-stage、Rust 1.99.1 Bookworm、`--locked --no-default-features`、runtime Debian Bookworm slim。`--no-default-features`はCLI既定のdenoise featureを無効化するが、Cargoの依存宣言上denoise crateや`lightcraft-gpu`のcompileがすべて消えるわけではない（ビルドログにcrate compileあり）。
- Linux package静的記載は`packaging/linux/nfpm.yaml`。CLI ELFの`ldd`実測は`libgcc_s.so.1`、`libm.so.6`、`libc.so.6`と動的loaderで、不足なし。CPU現像にVulkan/X11/Waylandライブラリ追加は不要だった。ベースイメージにglibc、`libgcc-s1`と計測用`time`を含む。
- `apps/lightcraft-web/src/wire.rs::WorkerCore::render`はRust側worker render。WASM JS exportsは`apps/lightcraft-web/src/web.rs::start`/`command`と`workers.rs::worker_main`で、フルWeb UI/worker command経路を支える。GenzoRoom Reactが直接呼べる独立renderer APIとしての配布・契約は確認できず、React adapter実装・build・browser実行は未検証。
- `crates/gpu/src/lib.rs`の説明ではWASMにWebGPU render pathはなく、CPU pipelineへfallback。Desktop Linux GPU pathは別途wgpuで、Docker PoCでは`LIGHTCRAFT_GPU_BACKEND=off`。
- LightCraftは`Cargo.toml`、`LICENSE-MIT`、`LICENSE-APACHE`、`NOTICE`でMIT OR Apache-2.0。GenzoRoomへの取り込み可否を法的に審査したものではない。組み込みを行う場合もLightCraftおよび依存物のlicense/NOTICE/asset attributionを保持し、LightCraftのbrand assetは別条件のため含めないこと。AGPL側への実際の配布形態・著作権表示は別途レビューが必要。

## 今回のNOTICE照合による補足（ソース上の事実）

根拠：`I:\code\lightcraft\NOTICE`、`LICENSE-MIT`、`LICENSE-APACHE`。workspaceの`MIT OR Apache-2.0`だけで同梱物すべての条件を代表させない。

- `crates/segment`はApache-2.0のみ。SAM 3 weightsは非同梱で、別途MetaのSAM License（非OSI）による取得。
- AI denoise weightsは非同梱。既定ビルドはユーザー提供モデルのみで、任意の`rawnind-model`は別途GPL-3.0 checkpointの取得・条件受諾を伴う。
- Interとcraft-fonts由来の同梱フォントはSIL OFL 1.1。ビルド入力・配布形態ごとの対象とライセンス本文を確認する。
- カメラ色行列の派生元にはrawtoaces-data（Apache-2.0）とCIEデータ（CC-BY-4.0）があり、`assets/ATTRIBUTION.md`を参照する。
- `crates/inpaint`のPhotoCraft由来部分はMIT OR Apache-2.0。`docs/images/`の記載された写真はpublic domain。
- GeoNamesデータは非同梱の任意ダウンロードでCC-BY-4.0。組み込む機能と実配布物に応じた確認が必要。
- `docs/brand/`の名称・wordmark・logoは上記オープンソースライセンスの対象外。`docs/brand/LICENSE-brand.txt`の別条件がある。

この補足はNOTICEの確認であり、全依存物の監査・AGPL配布条件の正式レビューは未実施。
