# C2-C geometry descriptor調査（2026-10-25）

基準Commit：`625a3fa8202eafbd6e4a0d1d65ff144c22d9d5a3`。対象ログ：`genzoroom-all-logs-20261025T005003Z.json`。
本調査は原因の確定のみで、geometryId、拒否条件、source選択、F、budget、座標変換の機能修正を含まない。

## 結果

実機と同一RAW・同一Recipeで`region_geometry_id_mismatch`を再現した。
Whole 2048は**Preview source**、Region preflight 4064は**Full source**を選び、hash入力descriptorの差分fieldは**`sourceAspect`だけ**だった。
分類は **B：source bitmapの整数寸法丸めをNative座標系に正規化する設計の候補**。
現行の二つのframeを無条件で重ねてよいという結論ではない。

## 実RAWの照合・再現方法

- 既存GenzoRoom RAW download cache内のDNGを使った。Native importのcontent hashを、当該assetの永続Recipe identityとメモリ内で照合し、一致したRAWだけを対象にした。
- Windowsの既存SQLiteをread-onlyで開き、ログと同じRecipe revision **120**を使用した。Nativeへreset/mergeした設定が永続設定と完全一致し、試験後もsettings hashが変わらないことをassertした。
- RAWの複製やRecipe全文をrepositoryへ追加していない。入力path、content hash、設定全文は非公開の一時入力に限り、reportには含めない。
- Wholeは通常の`render_job(...).run()`の実`Rendered.frame`を使い、`session.accept()`を挟んで1024→1472→2048を再現した。
- Regionは現行`execute_inner()`と同じFull-quality render job、source load、`pipeline::plan()`、Native寸法への既存capを通してframeを採取した。続いて既存Region処理を直接呼び、同じgeometry拒否が発生することをassertした。
- CPUおよび実DX12 GPUで照合した。これはNative調査試験であり、WebViewの目視受入や画質評価ではない。

元となるupstreamは`a2a41383c4fd62fa85a46ccd00998639221f2d3c`、managed patch digestは`8eb1aefa8bac815d2bc081cc79205023e33154eef78f5b5456daa59e5bee1813`。
既存のC1／診断用release EXE、receipt、manifest、managed patchは本工程で変更していない。

## 実測値

全てquality Full。Native寸法は全行 **4064×3056**。

| 経路 | 実sourceLevel | 実source bitmap | 出力F | sourceAspect / frame.aspect() |
|---|---|---|---|---|
| Thumb（256要求） | Thumb | 508×382 | 256×193 | 1.3298429319371727 |
| Whole 1024 | Preview | 2560×1925 | 1024×770 | 1.3298701298701299 |
| Whole 1472 | Preview | 2560×1925 | 1472×1107 | 1.3298701298701299 |
| Whole 2048 | Preview | 2560×1925 | 2048×1540 | 1.3298701298701299 |
| Region preflight 4064 | Full | 4064×3056 | 4064×3056 | 1.3298429319371727 |

Whole 1024はFile decode、1472/2048はそのPreview sourceのLoaded cache、Region 4064はFullのFile decodeだった。
いずれの実sourceも`SourceInfo.raw == true`、decoded lens metadataあり。embedded JPEG fallbackは使われていない。

### descriptor field比較：Whole 2048 → Region 4064

| field | 結果 | 値・根拠 |
|---|---|---|
| contract | identical | 1 |
| source | identical | `sourceMatches=true`。値は出力しない |
| original | identical | [4064, 3056] |
| sourceAspect | **different** | 2560/1925 → 4064/3056 |
| orientation | identical | Normal |
| crop.angle | identical | 0 |
| crop.rect.x0 / y0 / x1 / y1 | identical | 0 / 0 / 1 / 1 |
| flip | identical | [false, false] |
| warp.perspective | identical | 3×3 identity |
| warp.k1 | identical | -0.0 |
| warp.ca | identical | [0, 0, 0] |
| warp.lens | identical | center/radius/全planes/stages/vignetteまで一致 |
| warp.lensDist | identical | 1.0 |
| nativeWidth / nativeHeight | identical | 4064 / 3056 |

数値descriptor全体とsource level別の比較は[安全化済み実測データ](REGION_GEOMETRY_DESCRIPTOR_DATA.json)に保存した。
hash文字列の比較だけではなく、再構成したdescriptorのserialize bytesから計算するSHA-256が、本来の`frame_metadata()`のgeometryIdと完全一致することを各frameでassertしている。
field比較もserialize bytesで比較するため、`-0.0`と`0.0`のようなhash入力の差も見落とさない。

## sourceAspect差の直接原因

`frame_metadata()`は`sourceAspect = f.src_w / f.src_h`をdescriptorへ含める。
一方、`Frame::native_size_at()`はoriginalの寸法にorientationと正規化cropを適用するため、このRAWではproxy sourceの整数寸法に関係なく4064×3056になる。
`frame.aspect()`はsource側の`ow/oh`からcropの実寸を求めるため、sourceAspectと同じ微小差を持つ。

このRAWのPreview sourceはembedded JPEGではなく、`files::load_bytes_now()`のRAW decode経路にある。
Preview上限は2560。`bin_factor()`は90%下限2304に対して4064/2=2032なのでPreviewではbinを選べず、RAWを通常現像してから`raster::resample::fit(..., Filter::Box)`で縮小する。
`fit()`は両軸を整数へroundするため、理想高さ`3056 × 2560 / 4064 = 1925.0393700787401`が**1925**になる。
Fullは4064×3056を保つ。この整数丸めでsourceAspectが異なり、その数値がhash入力に入ることがgeometryId差の直接原因だった。

比率差は約0.002045%。小さい差でも、現行の厳密なdescriptor hashでは別geometryになる。

## source level依存性とfixture

- 実RAWのThumbは508×382で、Fullに対して各軸1/8なのでsourceAspectもdescriptorもFullと一致した。
- Previewだけ2560×1925という丸められた比率になり、descriptorの`sourceAspect`だけが変わった。
- 4064×3056の合成fixtureで、Thumb508×382／Preview2032×1528／Full4064×3056を与えると、bitmap寸法が異なってもdescriptor差分は空だった。
- 同じfixtureのPreviewだけ2560×1925へ変えると、実RAWと同様に差分は`["sourceAspect"]`だけになった。

したがって本件はsource levelのラベルやbitmap寸法そのものによる差ではなく、Preview bitmap寸法の整数丸めで変わるaspectをhashへ含めた結果である。

## source fieldの意味

WholeとRegionはいずれも`format!("{:?}", job.source_key)`を`frame_metadata()`へ渡す。
`Session::build_job()`の`source_key`は`Hasher128(content_key(photo))`で、renderのlevel・要求side・decode表現を含まない。
`content_key()`はcontent hashがあればそれを使い、なければDemo identityまたはfile identityへfallbackする。
本RAWはcontent hashが存在し、Thumb／Preview／Fullでsourceは完全一致した。
今回のgeometryId差に`source` fieldは寄与しておらず、sourceを除外しても本件の差分は解消しない。

## このRAWで有効なgeometry処理

Recipeのlens profile correctionは有効（`lens_profile=true`、`profile_distortion=100`）。実frameには同じlens warpが入り、Preview／Fullでcenter、radius、planesは全て一致した。
Auto Uprightはoff、upright_transformはnull、perspectiveはidentity。cropは全体、angle 0、constrain_crop=false。
手動distortion/CA、vertical/horizontal/rotate/aspect/offsetは0、scaleは100、orientationはNormal。
本件で自動解析結果やcrop/orientation/lensの切替は検出されなかった。

## 判断と次の設計案（未実装）

分類 **B**。original、正規化crop、orientation、lens/perspectiveが同一のNative座標系へ、整数proxyのsampling格子を正規化する設計を検討する。
候補は、原本のoriented寸法を正本とするcanonical Native geometryと、各source表現のsampling寸法・Nativeへの写像を分けて扱うこと。
その設計では、proxy aspectの丸めをgeometry identityへどう反映するかを決め、現行のlens/Frame座標変換との整合を証明してから実装する必要がある。
`sourceAspect`だけの無条件除外やmismatch許容は本調査の結論に含めない。

## 調査コード・試験・監査

[test-only Rust harness](../../../native/lightcraft/geometry_descriptor_probe.rs)と[launcher](../../../native/lightcraft/geometry_descriptor_probe.py)を追加した。
launcherは開始時にmanaged source全体を検証し、既存`region/tests.rs`へtest-only includeを一時的に追加する。
終了時には元のbytesへ復元し、再びmanaged patchとの完全一致を検証する。production source、release binary、公開契約は変更しない。
private入力は既存RAWへの参照とsettingsを含むため、ログやcommitへ入れない。reportはsource値を除外し、許可されたgeometryの数値・boolean・enumだけを保存する。

private入力JSONのkeysは`sourcePaths`（既存cache候補のpath配列）、`expectedContentHash`（Native content identity）、`settings`（照合対象のRecipe settings）、`recipeRevision`。
入力はrepository外の一時fileで渡す。launcherの引数は`--source`（検証済みmanaged checkout）、`--input`、`--output`（安全化report）、`--target-dir`（調査test用）、`--gpu-backend off|dx12`。
本調査で作成したprivate入力fileは試験後に削除し、既存RAW cacheと永続DBは保持する。

CPU／実DX12でそれぞれ2 tests passed。field差分の決定性、hash入力bytesの再現、source値/path非出力、実RAWのmismatch拒否維持、完全比例fixtureと丸めfixtureを確認した。
Python構文確認、追加Rustファイルのrustfmt check、`git diff --check`を実施した。
機能修正・C3 tuningは未実施。監査でHigh/Mediumの問題は見つからなかった。
