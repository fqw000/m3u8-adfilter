# m3u8-adfilter（本地可测的 HLS 去广告内核）

纯本地跑，不依赖 Surge。核心是一个纯函数，Node 直接调用；命令行负责抓取、跑测、落盘。

## 目录

```
m3u8-adfilter/
├── lib/filter-playlist.js     核心：解析 → 闸门 → 检测 → 打分 → 重建 → 自校验
├── bin/run.js                 命令行：抓远程 / 读本地 / 批量 / 落盘
├── test/
│   ├── run.js                 离线回归：fixtures 全量比对期望
│   ├── make-fixtures.js        生成 12 种广告插入形态的样本
│   └── mutate-real.js          在真实清单上注入广告，验证真实结构下的表现
├── fixtures/                   合成样本 + real/（真实底稿）
└── out/                        过滤后的 m3u8 + 报告
```

## 跑起来

```bash
# 单条远程
node bin/run.js --url "https://example.com/index.m3u8"

# 单条本地文件
node bin/run.js --file fixtures/01-scte-cueout.m3u8

# 整个目录批量
node bin/run.js --dir fixtures

# 一批 URL（每行一个，# 开头为注释）
node bin/run.js --list urls.txt --json

# 只观察不改写（推荐先用这个跑真实片源）
node bin/run.js --url "https://..." --dry-run --verbose
```

产物：`out/<slug>.report.txt`（完整日志）、`out/<slug>.filtered.m3u8`（仅在改动时生成）、`out/summary.json`（加 `--json` 时）。

## 三道离线回归

```bash
node test/make-fixtures.js   # 生成样本
node test/run.js             # 12 种广告形态，比对期望
node test/mutate-real.js     # 真实清单 + 注入广告
```

## 核心设计（为什么不是"打标签就删行"）

1. **解析成段节点**：每个分片持有归属自己的标签（`KEY` / `DISCONTINUITY` / `CUE` / `PDT` / `BYTERANGE`），删除以"块"为单位，整块删。
2. **闸门先行**：master、直播（无 `ENDLIST`）、`BYTERANGE` 无 `@offset`、**AES-128 隐式 IV** 一律原样放行。
3. **检测器只产证据**：`scte` / `keynone` / 规则 → 强证据（直接判定）；形状类（均匀短块、不连续边界、主机偏离、命名偏离、循环复用、短块夹长块、密集流极短块、序号孤岛）→ 加权累加。
4. **结构守恒**（最容易翻车的地方）：
   - `KEY` 状态机：有效密钥变了才补一行，删块后不会留下悬空 `KEY:NONE`
   - 接缝 `DISCONTINUITY`：两侧都有 → 合并成一个；都没有 → 不新增
   - `CUE-OUT` / `CUE-IN` 配对：孤立的一方被清掉
   - `MEDIA-SEQUENCE` / `DISCONTINUITY-SEQUENCE`：只改开头被删的部分
5. **重建后自校验**：段数、`#EXTINF` 数、连续 `DISCONTINUITY`、CUE 配平、剩余段数；任一不过就回滚原文（日志 `RESULT: REVERT`）。

## 关键参数（lib 里 `DEFAULTS`）

| 项 | 默认 | 说明 |
|---|---|---|
| `baseThreshold` | 0.60 | 中间块判定阈值 |
| `firstBonus` / `lastBonus` | +0.20 / +0.10 | 首尾块阈值更高，防误删片头 |
| `minAdBlockSegments` / `maxAdBlockSegments` | 2 / 8 | 广告块段数窗口 |
| `minAdBlockDurationSec` / `maxAdBlockTotalSec` | 4 / 36 | 单片时长下限 / 整块时长上限 |
| `keynoneBounded` | `both` | 明文块必须两侧都是密文才算数 |
| `skipImplicitIV` | true | AES-128 无 `IV=` 时整体放行（红线） |
| `dryRun` | false | 只判定不改写 |

## 采集你自己的片源

浏览器 / 抓包 / 代理把真实 `m3u8` 原文存到 `fixtures/real/`，然后：

```bash
node bin/run.js --dir fixtures/real --dry-run --verbose
```

先看 `CHUNKS` 的打分和 `REMOVED` 候选是否合理，再决定是否去掉 `--dry-run`。真实片源的 URI 常带签名参数，建议直接用原始 URL 跑（`--url`），因为签名会影响"命名特征"的判断。

## 已知限制

- **无标记的同源广告**：广告与正片同域名、同命名规律、时长也一致时，没有可判定的信号，会漏删。这类只能靠规则库（`RULES.hostRules`）补特征。
- **`SAMPLE-AES`**（DRM 分片加密）：一律不操作，和主流项目保持一致。
- **直播 / EVENT**：默认放行，删除会破坏播放器序列预期。
- **`BYTERANGE` 无 `@offset`**：放行，删段会导致字节偏移链断裂。

## 接回 Surge

`lib/filter-playlist.js` 是纯函数，接 Surge 只需一层胶水：

```js
const reqUrl = $request.url;
const body = $response.body;
if (typeof body !== 'string' || body.indexOf('#EXTM3U') !== 0) { $done({}); }
else {
  const r = filterPlaylist(body, reqUrl, { verbose: false });
  r.report.lines.forEach((l) => console.log(l));
  $done(r.changed ? { body: r.body } : {});
}
```

Surge 不支持 `require`，把 `lib` 内容直接内联到脚本里即可（保持"纯函数 + 胶水"两层，方便以后继续在本地回归）。

> （注：部分内容由豆包 AI 生成）