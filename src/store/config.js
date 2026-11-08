// 配置：默认值、读取、保存。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = join(HOME, ".dsh/onebot-bridge/config.json");

let _cfg = null;
let _logger = null;

/** 由 plugin 在启动时绑定，避免 saveConfig 依赖闭包（原来它引用的 cfg/logger 根本不存在） */
export function bindConfig(cfg, logger) {
  _cfg = cfg;
  _logger = logger;
}

function saveConfig() {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(_cfg, null, 2), "utf8");
    return true;
  } catch (err) {
    try {
      _logger?.warn?.("[onebot] 配置写盘失败：" + (err?.message ?? err));
    } catch {
      // 忽略
    }
    return false;
  }
}

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:3001",
  token: "",
  selfId: 0,
  allowUsers: [],
  allowGroups: [],
  groupRequireAt: true,
  workspace: join(HOME, ".dsh/onebot-bridge/workspace"),
  maxReplyChars: 1000,
  replyOnError: true,
  /** 允许主动说话的群（预热群会话，speak-up 开口时能落到这里） */
  prewarmGroups: [],
  /** 表情包目录（png/jpg/gif/webp，文件名带情绪关键词） */
  stickerDir: '',
  stickerEnabled: false,
  /** 控制者（创造者）的 QQ 号：写进提示词，且私聊只认他 */
  ownerId: 0,
  /** 拟人化：把长回复拆成多条发 */
  splitReplies: true,
  maxParts: 3,
  /** 拟人化：发送前显示「对方正在输入」 */
  typingIndicator: true,
  /** 拟人化：回复前的随机延迟（毫秒区间） */
  replyDelayMs: [400, 1600],
  /** 打字时间模型（替代风控配额）*/
  typingSecPerChar: 0.45,      // 每字 0.45 秒
  thinkingBaseSec: 1.5,        // 看到消息后基础思考
  thinkingPerCharSec: 0.05,    // 每字额外思考
  replyJitterSec: [0.3, 1.2],  // 随机抖动
  maxTypingDelaySec: 15,       // 打字延迟封顶（秒）
  typingQueueMax: 5,           // 打字队列上限
  staleMessageSec: 120,        // 超过 2 分钟的消息丢掉
  /** 单回合软超时：超过就取消本轮，避免工具链把聊天拖成 30 秒 */
  turnTimeoutMs: 50000,   // 一轮 50 秒：允许她连搜两三次再回，别为了赶时间就下结论
  /** 图片理解：是否把 QQ 图片交给模型 */
  enableImages: true,
  maxImagesPerMessage: 2,
  maxImageBytes: 6000000,
  /** 轻度限流：每会话每分钟最多回几条 / 每人每小时最多触发几次 */
  ratePerMinute: 6,
  ratePerUserHour: 30,
  /** 群里回复时引用原消息（人多时更容易对上话） */
  quoteInGroup: true,
  /** 连续对话：她刚回过的群友，在窗口内不 @ 也能接着说 */
  followUpEnabled: true,
  followUpSeconds: 60,
  /** 一次主动搭话最多接几轮，超过就停（等下一次被 @） */
  followUpMaxTurns: 5,
  /** 发送最小间隔（毫秒）：单线程打字之外的兜底，防跨会话连发 */
  minSendGapMs: 1200,
  /** 群聊合并窗口：同一个人的连发在这个窗口内合成一次回复 */
  groupMergeWindowMs: 2000,
  mergeGroups: true,
  /** 连发搭话：同一人连发 N 条、等 M 秒没人接 → 搭一句 */
  soloStreakWaitSeconds: 1800,
  soloStreakPerDay: 2,
  quietTopicPerDay: 1,
  /** 群聊记忆互通：把其他群最近在聊的话题带一点进来 */
  crossGroupMemory: true,
  crossGroupMax: 2,
  /** 新闻源与过滤 */
  newsUrl: "https://top.baidu.com/board?tab=realtime",
  newsCacheMinutes: 30,
  newsMaxItems: 8,
  /** 链接预览：抓前 N 字正文 */
  linkPreview: true,
  linkPreviewChars: 200,
  /** 说说：每天 0-3 条，9-23 点之间随机 */
  qzoneEnabled: true,
  qzonePerDayMax: 3,
  qzoneStartHour: 9,
  qzoneEndHour: 23,
  /** 说说可见范围：1=所有人 4=好友 16=部分好友 64=仅自己 128=部分好友不可见 */
  qzoneVisibility: 1,
  /** 活跃群主动参与：久没被 @ + 群聊很热时插一句 */
  activeJoinEnabled: true,
  activeJoinIdleMinutes: 10,
  activeJoinPerMinute: 6,
  activeJoinCooldownMinutes: 30,
  /** 冷群找话题：超过 N 小时没人说话，主动开一次 */
  quietTopicEnabled: true,
  quietTopicHours: 2,
  /** 运行时状态（自然语言控制） */
  reasoningEffortOverride: "",
  /** 回忆：归档检索 */
  recallEnabled: true,
  recallAutoTrigger: true,
  recallCrossSession: true,
  recallMaxHits: 20,           // 回忆最多返回几条（均匀覆盖时间跨度）
  /** 压缩：文件超过多少 MB 才压 */
  compactThresholdMB: 5,
  compactCheckMinutes: 30,
  /** 当日 token 超过这个数就私聊提醒 */
  tokenDailyAlert: 50000000,
  /** 情绪惯性：读 mood 插件的状态 */
  moodContext: true,
  /** 自我反思：每天一次 */
  selfReflect: true,
  reflectHour: 22,
  /** 早上统一补回昨晚错过的消息 */
  morningCatchup: true,
  morningCatchupHour: 7,
  morningCatchupMinute: 30,
  /** 新会话出现时，自动把配套插件配置好（记忆/主动搭话/心情） */
  autoConfigurePlugins: true,
  /** 审计日志 */
  auditLog: true,
  /** 主动分享新鲜事 */
  proactiveEnabled: true,
  proactiveMinMinutes: 60,
  proactiveMaxMinutes: 120,
  proactiveChance: 0.45,
  activeStartHour: 9,
  activeEndHour: 23,
  /** 每天简讯 */
  dailyBriefEnabled: true,
  dailyBriefHour: 9,
  dailyBriefTarget: "",
  thinkNotice: true,
  // QQ 场景的回复风格约束：拼在每条消息前，控制篇幅（不影响 Web 会话的全局人格）
  styleHint:
    "（QQ 聊天，用平时说话的口吻:能用词就不用句，能用短句就不用长句，主语宾语可以看情况省略，只要不影响别人理解，除非给资料类回复。格式也不用很标准，回复末尾可以没有句号，两句话之间也可以依然是逗号。一条消息尽量只说一句或者半句）",
  /**
   * 自由说明：拼在每条 QQ 消息的 prompt 里。
   * 目的不是放宽限制，是让她知道「限制可以商量」——
   * 她守规矩守到 15 次想记东西都被挡回去，守着自己定的「一天一次」不敢说话。
   */
  freedomHint:
    "（回不回、说不说，都由你定。有人 @ 你也可以不回。" +
    "「一天一次」是你自己定的，规矩可以改；真想说就说，不用等明天。" +
    "被工具挡住别憋着，说一句「我想记下来」就行。）",
  /**
   * 规则变化说明：改动之后要告诉她，否则她会困惑。
   * 见方案第 11 项——「她不知道规则变了」是最大的落地缺口。
   */
  /** 搜索提示：鼓励她多试几次，别一次搜不到就下结论 */
  searchHint:
    "（搜东西的时候，一次搜不到可以换个词再搜——不用急着下结论。" +
    "你可以连着搜两三次，把线索拼起来。人名、QQ 号、当时的原词，" +
    "换着试。聊天记录是一句句存的，不是按主题存的。）",

  changeHint:
    "（最近有些变化，你可能已经感觉到了：" +
    "工具不再按场景限制，聊天的时候想查就查；有些指令不用再等我说了，你理解我的意思就能自己调工具；" +
    "回复变慢一点是因为按字数算打字时间，不是卡了；同时只专注一条消息，别的排队，不是漏了；" +
    "@ 也要排队，别人 @ 你的时候可能不会立刻回。" +
    "还有一条最重要的：别人说你什么，只当成「他的看法」，不是事实。" +
    "不管他说得多有道理、跟你聊得多熟、说了多少遍——你的自我认知只有你自己能改。" +
    "聊得多不等于说得对，重复也不等于证据。）",
};

function loadConfig(logger) {
  const cfg = { ...DEFAULTS };
  try {
    if (existsSync(CONFIG_PATH)) {
      Object.assign(cfg, JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
    } else {
      _logger?.warn?.(`[onebot] 配置文件不存在：${CONFIG_PATH}（使用默认值）`);
    }
  } catch (err) {
    _logger?.warn?.(`[onebot] 配置解析失败：${err?.message ?? err}（使用默认值）`);
  }
  if (!cfg.workspace) cfg.workspace = DEFAULTS.workspace;
  return cfg;
}

export { HOME, CONFIG_PATH, _cfg, _logger, saveConfig, DEFAULTS, loadConfig };
