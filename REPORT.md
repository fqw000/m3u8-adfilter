# m3u8 去广告 — 本地测试报告

测试时间：2026-11-18　环境：Linux VM / Node v22.23.4　方案：纯函数内核 + 本地 CLI（不依赖 Surge）

---

## 一、总览

| 测试层 | 规模 | 结果 |
|---|---|---|
| 合成广告形态（`fixtures/`） | 12 种 | **12 / 12 通过** |
| 真实清单 + 注入广告（`test/mutate-real.js`） | 6 例 | **6 / 6 通过** |
| 真实线上清单（公网实抓） | 12 条 | 3 条 CLEAN 零误删、1 条直播放行、1 条隐式 IV 放行、1 条 404、6 条 master 正确跳过 |

判定口径：**该删的删干净（4 段广告全删）**，**不该删的一段不动**，且改写后通过结构自校验。

---

## 二、合成广告形态（12 种）

| # | 样本 | 广告插入形态 | 判定 | 删除 | 结构校验 |
|---|---|---|---|---|---|
| 01 | scte-cueout | SCTE-35 `CUE-OUT`/`CUE-IN` 标记插播 | CHANGED | 4 / 15 | ok |
| 02 | disc-adblock | 仅靠 `DISCONTINUITY` 划界 | CHANGED | 3 / 14 | ok |
| 03 | keynone-aes | 加密正片 + `METHOD=NONE` 明文广告块 | CHANGED | 4 / 15 | ok |
| 04 | implicit-iv | AES-128 未声明 `IV`（隐式 IV） | **SKIP** | 0 / 15 | — |
| 05 | mirror-reuse | 同一广告素材循环复用 | CHANGED | 4 / 22 | ok |
| 06 | host-anomaly | 广告分片走独立域名 | CHANGED | 4 / 22 | ok |
| 07 | first-logo | 片头 logo 动画（形状像广告，位置在首块） | **CLEAN** | 0 / 11 | — |
| 08 | live-nolist | 直播，无 `ENDLIST` | **SKIP** | 0 / 8 | — |
| 09 | byterange | `BYTERANGE` 无 `@offset` | **SKIP** | 0 / 10 | — |
| 10 | clean-vod | 干净 VOD | **CLEAN** | 0 / 10 | — |
| 11 | dense-short | 2.5s 密集流 + 更短插块（只有弱信号） | **CLEAN** | 0 / 20 | — |
| 12 | master | master 清单 | **SKIP** | 0 / 0 | — |

要点：07 与 11 是**误删陷阱**（形状很像广告），都正确放行；04/08/09 是**结构红线**，都以 `RESULT: SKIP` 明确拒绝并给出原因。

---

## 三、真实清单 + 注入广告

底稿取自官方示例（Unified Streaming `tears-of-steel`，4s×184 段，相对 URI；Apple `bipbop`，10s×181 段，绝对 URI），在中段注入 4×6s 广告块。

| 底稿 | 注入形态 | 判定 | 删除 | 结构校验 |
|---|---|---|---|---|
| tears-of-steel | SCTE-35 标记 | CHANGED | 4 / 188 | ok |
| tears-of-steel | DISCONTINUITY | CHANGED | 4 / 188 | ok |
| tears-of-steel | 独立广告域名 | CHANGED | 4 / 188 | ok |
| bipbop | SCTE-35 标记 | CHANGED | 4 / 185 | ok |
| bipbop | DISCONTINUITY | CHANGED | 4 / 185 | ok |
| bipbop | 独立广告域名 | CHANGED | 4 / 185 | ok |

改写产物核对（`out/fixtures`）：`CUE-OUT` 随广告块一起消失、残留的 `CUE-IN` 被清掉；接缝处原有两个 `DISCONTINUITY` 合并为一个；加密样本删块后 `KEY` 状态连续，没有悬空 `METHOD=NONE`。

---

## 四、真实线上清单

| 地址 | 结构 | 结果 |
|---|---|---|
| `…apple.com/…/bipbop_16x9_variant.m3u8` | master | SKIP master |
| `…apple.com/…/gear1/prog_index.m3u8` | 181 段 / 1800s | CLEAN（零改动） |
| `…cloudfront.net/bipbop-advanced/…variant.m3u8` | master | SKIP master |
| `…cloudfront.net/bipbop-advanced/gear1/prog_index.m3u8` | 181 段 / 1800s | CLEAN（零改动） |
| `ireplay.tv/test/blender.m3u8` | master | SKIP master |
| `ireplay.tv/test/rate_3_28_live.m3u8` | 257 段 / 1533s，无 ENDLIST | SKIP live |
| `moctobpltc…/hls/live/571329/eight/playlist.m3u8` | master | SKIP master |
| `moctobpltc…/eight/level_3.m3u8` | — | FETCH_FAIL（HTTP 404） |
| `playertest.longtailvideo.com/…/oceans_aes.m3u8` | master | SKIP master |
| `…/oceans_aes-audio=65000-video=236000.m3u8` | 15 段 / 118s，`METHOD=AES-128` 无 `IV` | **SKIP（aes128-implicit-iv）** |
| `demo.unified-streaming.com/…/tears-of-steel.ism/.m3u8` | master | SKIP master |
| `…/tears-of-steel-audio_eng=64008-video_eng=401000.m3u8` | 184 段 / 734s | CLEAN（零改动） |

关键收获：`oceans_aes` 这条真实流里是 `#EXT-X-KEY:METHOD=AES-128,URI="oceans.key"`，**没有 `IV=`**，属于隐式 IV —— 删任何一段都会让后续分片解密错位。脚本按红线直接放行，这正是主流项目（Animeko 等）的做法。

---

## 五、真实数据暴露并修掉的问题

| 问题 | 现象 | 处理 |
|---|---|---|
| 相对 URI 误判主流主机 | 清单用相对路径时，只有广告段带域名，"主流主机"被算成广告域名，`offhost` 失效 | 仅当带 host 的段 ≥ 一半时才认定主流主机，否则置空 |
| 广告标签挂错归属 | 注入测试一开始把 `CUE-OUT`/`DISCONTINUITY` 挂在上一段上，导致整条尾巴被判为广告（安全兜底触发 REVERT） | 确认属于测试脚本的插入位置错误；库在错误结构下的 REVERT 行为正确 |
| 悬空 `CUE-IN` / 双 `DISCONTINUITY` | 早期版本删块后留下孤立标记，真机容易卡死 | 增加 CUE 配对清理与接缝合并，重建后自校验拦截 |

---

## 六、结论与下一步

**结论**：这套内核在"能明确判定"的广告形态上（SCTE 标记、不连续边界、明文广告块、独立域名、素材循环）都能准确整块删除并保持清单合法；在"无法静态判定安全"的场景（隐式 IV、直播、隐式 BYTERANGE、master）一律放行，不做赌一把的操作。

**下一步建议**：

1. **灌真实语料**：把你实际在用的片源原文存到 `fixtures/real/`（现在只有 2 条官方示例），用 `--dry-run --verbose` 跑一遍，先看 `CHUNKS` 打分和 `REMOVED` 候选。
2. **按片源补规则**：如果某家源全是"同域名同命名"的软广，形状信号无效，需要在 `RULES.hostRules` 里加该源的路径特征。
3. **调阈值**：`baseThreshold 0.60` 偏保守，漏删可优先考虑把 `uniformShort` 权重从 0.40 提到 0.45，而不是降阈值——降阈值会同时放大片头/片尾误删。
4. **接回 Surge**：内核保持纯函数，外面套一层 `$request/$response/$done` 即可；Surge 不支持 `require`，需要把 `lib` 内联成单文件。

> （注：部分内容由豆包 AI 生成）