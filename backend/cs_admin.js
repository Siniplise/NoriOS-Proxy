'use strict';
/* ==========================================================================================
 * 和合医疗后台（concord-clinic.med/admin）—— 本地移植
 *
 * 背景：官方 os.inori.ai 已关站；随包离线存档只抓到 `/`（灵堂）与 `/login` 两页，
 *   没有 `/admin`。本地 exe 也未实现 concord.login.submit（输入密码直接回「密码不正确」）。
 *   ⇒ 本模块按录像 1:1 复刻后台页，并由 nori_proxy.js 接管页面与登录命令。
 *
 * 内容来源：bilibili BV1F68V6EErG（@孤独音符《NORI_OS 全流程精剪实况》）
 *           时间点 0:52:50–0:58:30；逐帧读取所得。
 * 归档：_arch/106_concord_admin_jack_diary.md ＋ 关键帧 _arch/_video/concord_admin/
 *
 * 复刻依据（实拍）：
 *   · 外观 = WordPress 风格后台，页脚署名「墨匣 4.2.1，使用素页主题。」
 *   · 顶部横幅「数据库处于只读模式：本站点的所有写入操作均已停用。您可以浏览内容，但任何更改都不会被保存。」
 *   · 左侧菜单：仪表盘/文章/媒体/页面/评论/外观/插件/用户/工具/设置 ｜「折叠菜单」
 *   · 文章列表：全部(12) 已发布(1) 私密(11)；列＝标题｜作者｜分类目录｜标签｜评论｜日期
 *   · 概览：12 篇文章 · 0 个页面 · 0 条评论
 *   · 编辑器侧栏：状态/可见性(私密)/发布 时间/移至回收站/分类目录/标签/特色图片
 *
 * ★ 未展示的日记（Day 1 / Day 27 / 另 2 篇）正文在录像中未出现 —— 按世界观写成
 *   「条目在离线存档中已丢失」，不编造内容。见 CS_POSTS 的 body: null。
 * ========================================================================================== */

const CS_BASE = 'https://concord-clinic.med';
/** 原版密码（用户实测自录像）。不是杰克自己的名字，而是他病人「小宇」+ 生日 11/23。 */
const CS_PASSWORD = 'xiaoyu1123';

const CS_FONT = "'Noto Sans SC','Microsoft YaHei','PingFang SC',system-ui,-apple-system,sans-serif";

/* ★★★ 字体必须带 url —— 客户端的 page schema 是【双重 strict】：
 *     z.object({...}).strict()、且 fonts: z.array(z.object({family,url,weight?,style?}).strict())
 *   ⇒ fonts[].url 缺了 ⇒ 整个 page 校验失败 ⇒ 页面空白 + 反复重拉。
 *   直接照抄包里 concord 页的写法（同一个站点，字体也一致）。 */
const CS_FONTS = [{ family: 'Concord LiSu', url: '/webAssets/concord/simli-concord.woff2' }];
const CS_FAVICON = '/webAssets/concord/favicon.svg';

/* ── 日记正文（逐字录入自录像；段间空行用 \n\n 表示） ───────────────────────── */
const CS_POSTS = [
  {
    n: 1, id: 78, date: '5月15日', priv: true, shown: false, body: null,
  },
  {
    n: 16, id: 84, date: '5月30日', priv: true, shown: true,
    body: [
      '诊所的场地总算谈下来了。设备全是别的地方退下来的二手货，但勉强能用。我自己搭了连接 AlephPro 的节点，调整涌现费了我很大劲，基本全靠自己 DIY。说实话，我到现在也说不清它到底是怎么运作的，但现在这个阶段能用就够了。',
      '目前手头的病例是我最有把握的类型：一个克雅氏病晚期，两个渐冻症晚期，一个自理都困难的阿尔茨海默症。主要是因为 我之前在公司做的几乎就是这类病人，已经差不多了解流程了。但也是因为 这些人本身就是死路一条了，哪怕对齐了没用，那也是他的命，怪不得我头上。我清楚 我在利用这一点，但不这样我无法迈出第一步……',
      '以及，钱是个大问题。AlephPro 的接入比我想的烧钱。',
    ],
  },
  {
    n: 27, id: 90, date: '6月10日', priv: true, shown: false, body: null,
  },
  {
    n: 52, id: 93, date: '7月5日', priv: true, shown: true,
    body: [
      '一个月前对齐的阿尔茨海默症的老爷子回来看我了，他气色很好，还记得我的名字。我把这事发 Pulse 了，底下一片叫好。',
      '其实那之后，他女儿把我叫到一旁问为什么老人记得一些从没发生过的事。我跟她说，这是认知恢复过程里常见的记忆错构，大脑在重新连线的时候会自己填补空缺，过阵子就好了。',
      '我不知道我是不是在骗她……我清楚副本不是凭空出现的。我把另一条世界线上的神经流形覆盖过来的时候，会不会，也把那条线上的他真实经历过的一段人生，一起带了过来？',
      '不，一个例而已，八成真就是记忆错构。要是后面的人陆续也出现类似的情况再说，现在远没到停下来想这些的时候呢。',
    ],
  },
  {
    n: 58, id: 97, date: '7月11日', priv: true, shown: true,
    body: [
      '钱不够用，但对那些倾家荡产来找我的人，我又张不开口要钱。',
      '今天来了一位母亲，要我“治”她儿子的网瘾、逃学。这能算什么病啊？我想直接拒绝，可她给的钱够我多救八九个正在等死的人。',
      '收吧。不就是劫富济贫嘛，拿有钱人的钱去换没钱人的命，这笔钱来得正是时候。可那孩子根本没病，我答应的话，和弗图姆那帮人还有什么两样？',
      '话虽如此，我到底还是好奇。一直以来诊所收的都是重症病人，可这个孩子不一样，一个相对健康的、还在发育的大脑，神经流形可塑性又高。在这样一张白纸上做对齐，会是什么样子？',
      '我本该拒绝的，虽然我清楚我不会拒绝……',
    ],
  },
  {
    n: 65, id: 101, date: '7月18日', priv: true, shown: true,
    body: [
      '提到一些没发生过的怪事，说什么小时候养过一条狗、咬了邻居家的十只鸡，全家一起爬过海拔几千米的山。我又拿那套说辞糊弄过去，说大脑在调整期会自己填补空缺，过阵子就好了。',
      '可这次我心里清楚，绝对不是这么一回事。',
      '之前的病人认知本来就不健全，发生记忆错构也正常。但这孩子根本没有任何东西需要填补。对齐，搞不好只是把那个不逃学、不打游戏的他的副本整个覆盖掉了原本的他。这位母亲带回去的，根本是另一个孩子。',
      '可这难道不正说明对齐成功了吗？彻底的、干净的覆盖，连记忆也一并迁移过来了，这是何等精确的操作！我大概是第一个在活体上实现完整意识替换的人，我是第一个。这要是写出来，是历史级的操作，教科书级的操作。后人回望这一刻，会明白今天在这间小小的诊所里，发生了什么？',
      '我在写什么？我是在为这件事得意吗？',
      '我快要搞不清楚自己的感觉了。',
    ],
  },
  {
    n: 69, id: 104, date: '7月22日', priv: true, shown: true,
    body: [
      '受不了了，我需要写几句正经的不抖机灵的话……哦，原来我还写得出来啊。',
      '翻我自己发的那些帖子、那些自拍，会觉得那根本不是我。那可是我打的字，我记得我打的时候还挺……爽的。想想看，被那么多人看着、登上热搜、一句话就是几万转，那种感觉。你们这些坐在实验室里发不出论文的人，一辈子都体会不到。谁对谁错，一目了然。他们当年瞧不起我，把我从赶出去，现在所有人都在评论区喊我大神！多好啊。这才是我该待的位置，所有人都看着我、所有人都需要我，所有人都……',
    ],
  },
  {
    n: 73, id: 108, date: '7月26日', priv: true, shown: true,
    body: [
      '有个八岁孩子的父亲一直在我的帖子底下留言，说孩子得了一种不明原因的神经退行。我让他先把检查资料传过来，偏偏诊所那个上传页又出了问题。他说自己就是做网页开发的，顺手帮我看了一下，不到半天就把上传资料和预约两个页面都修好了，还改了 几个我一直懒得修的 bug，倒是省事了。资料传上来以后，我一看。八岁。这会是我接过最年轻的一例。接啊，为什么不接？从来没有任何人在这么小的孩子身上做过对齐，那会展开成什么样子？我真的，孩子啊，我真的太想知道了。这种问题全世界也只有我有资格问、有能力回答。',
      '有没有把握？当然有风险。可话又说回来，开创性的事，哪一件不是从“没人做过”开始的？真正的第一次，注定要由一个不怕的人来完成。这个人是我。这个人会是我。',
      '要是成了，它就不只是又救一个孩子，它会是一道分水岭，往后整个神经科学领域会被分成两半：杰克·怀特之前，和杰克·怀特之后。天啊，决定性的一笔。我等这样的病例已经很久了。',
    ],
  },
  {
    n: 77, id: 111, date: '7月30日', priv: true, shown: true, last: true,
    body: [
      '终于来了。他们两个终于来了。孩子坐在轮椅上，头歪到一边，瘦得让我怀疑是否还活着。可怜吗？可怜。但是我终于等到你了，你终于等到我了。神经活动还算勉强读取得出，但最刺激的还是比对环节。',
      '导进 AlephPro，一匹配，果然跟我预想的一模一样，问题很大。信号弱到即使在离线表征下节点也定不下来，好几条疑似副本之间来回摇摆，根本没有一条像样的能对齐的副本。换了你我也都算，换个狗屁的庸才，到这一步就收手了，回家吧孩子，让该收拾收拾准备后事了。',
      '可我不是一个庸才，我想到了办法。方法很简单：既然找不到副本，那就有条件了，那不改条件不就可以了吗？把源值的位点上加，加到能漂亮亮地看到那条波形为止。对，对弗图姆当年是给这个值定上限，可那个上限又是什么东西？一群酒囊饭袋，这辈子没做过一个真正的「实验」的人，拍脑袋定下来的一个数值嘛。不就是这个吗？',
      '他们怕，我不怕。这个限制多半也是怕把设备跑坏，设备坏了再修嘛，人修坏了再招。跟一个能载入史册的第一次比起来，一台机器又算什么？我要把它加到前所未有的值。你们知道那意味着什么吗？意味着我在亲手验证连弗图姆都不敢探测的地方到底有什么。',
      '这已经不再是医学了，这是探险，是把旗子插上从来没有人踏足过的极点，而握着旗子的那个大队长就是我。我已经等不及了，我已经一分钟都等不下去。',
    ],
  },
  /* Day 77 之后的两篇（编号未知、正文未展示）—— 补足原版「私密 (11)」的计数 */
  { n: 78, id: 114, date: '7月31日', priv: true, shown: false, body: null },
  { n: 79, id: 117, date: '8月1日', priv: true, shown: false, body: null },
  /* 讣告（公开）—— 正文是灵堂页的整页 HTML（原版如此） */
  {
    n: 0, id: 121, date: '8月2日', priv: false, shown: true, sticky: true,
    title: '沉痛悼念杰克·怀特医生，音容宛在', code: true,
    body: [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '    <meta name="theme-color" content="#17120e" />',
      '    <title>和合医疗 Concord Clinic</title>',
      '    <link rel="preload" href="/webAssets/concord/poster.jpg" as="image" />',
      '    <style>',
      '      :root { color-scheme: dark; --loop: 7.6s; --gold: #ffcf3a; }',
      '      body { background: #0b0a08; color: #e7ddc9; }',
      '      .hero { display: grid; min-height: 100dvh; place-items: center; }',
      '      .poster { position: relative; width: min(92vw,480px,calc(100dvh * .72)); aspect-ratio: 4/5; }',
      '      .wordart { color: #fff838; }',
      '    </style>',
      '  </head>',
      '  <body>',
      '    <section class="hero">',
      '      <div class="poster" id="poster" aria-label="沉痛悼念杰克·怀特医生">',
      '        <h1 class="sr-only">沉痛悼念杰克·怀特医生，音容宛在</h1>',
      '        <video class="valley" src="valley-480.mp4" poster="poster.jpg"',
      '          autoplay muted loop playsinline></video>',
      '        <img class="peony" src="peony-keyed-loop.webp" />',
      '        <img class="portrait portrait-main" src="portrait-cutout.png" />',
      '        <div class="wordart wordart-top">沉痛悼念</div>',
      '        <div class="wordart wordart-bottom">永远怀念</div>',
      '      </div>',
      '    </section>',
      '    <script>',
      '      // BGM is played by the HOST browser app — a sandboxed iframe cannot autoplay audio.',
      '      const peonyLoopSource = \'/webAssets/concord/peony-keyed-loop.webp\'',
      '      function restart(){ poster.classList.remove(\'is-playing\'); void poster.offsetWidth;',
      '        poster.classList.add(\'is-playing\'); }',
      '      restart()',
      '    </script>',
      '  </body>',
      '</html>',
    ],
  },
];

/* 日期 → 排序用毫秒（原版列表按「日期」升序，最旧在前） */
const CS_MONTHS = { 5: 0, 6: 1, 7: 2, 8: 3 };
function csTime(p) {
  const m = String(p.date).match(/(\d+)\s*月\s*(\d+)\s*日/);
  if (!m) return 0;
  return CS_MONTHS[Number(m[1])] * 100 + Number(m[2]);
}
const CS_LIST = CS_POSTS.slice().sort((a, b) => csTime(a) - csTime(b));
const CS_LAST_DAY = CS_POSTS.filter((p) => p.n > 0).reduce((m, p) => Math.max(m, p.n), 0);

/* 悬停才出现的行内操作（原版 WP：row-actions） */
const ROW_ACTIONS = '<span class="row-actions">'
  + '<span class="edit"><a href="#">编辑</a> | </span>'
  + '<span class="inline hide-if-no-js"><a href="#">快速编辑</a> | </span>'
  + '<span class="trash"><a href="#">移至回收站</a> | </span>'
  + '<span class="view"><a href="#">查看</a></span></span>';

/* ── 后台骨架（侧栏 + 顶栏 + 只读横幅） ───────────────────────────────────── */
/* ★ 链接一律用【完整 URL】：客户端 shim 会把 `href="#"` 当作页内锚点原地吞掉
 *   （点了没反应）。只有 http(s) 的绝对地址才会被路由器接管并真正导航。 */
function csMenu(active) {
  const POSTS = CS_BASE + '/admin/posts';
  const DASH = CS_BASE + '/admin';
  const items = [
    ['仪表盘', 'dash', DASH], ['文章', 'posts', POSTS], ['媒体', 'media', '#'],
    ['页面', 'pages', '#'], ['评论', 'comments', '#'], ['外观', 'themes', '#'],
    ['插件', 'plugins', '#'], ['用户', 'users', '#'], ['工具', 'tools', '#'],
    ['设置', 'options', '#'],
  ];
  const li = items.map(([label, key, href]) => {
    const on = key === active ? ' current' : '';
    return '<li class="menu-top' + on + '"><a href="' + href + '"><span class="dashicons"></span>'
      + label + '</a></li>';
  }).join('');
  const sub = (active === 'posts')
    ? '<ul class="wp-submenu">'
      + '<li class="current"><a href="' + POSTS + '">所有文章</a></li>'
      + '<li><a href="#">写文章</a></li>'
      + '<li><a href="#">分类目录</a></li>'
      + '<li><a href="#">标签</a></li></ul>'
    : (active === 'dash'
      ? '<ul class="wp-submenu"><li class="current"><a href="' + DASH + '">首页</a></li>'
        + '<li><a href="#">更新</a></li></ul>'
      : '');
  const subWrap = sub ? '<div class="subwrap">' + sub + '</div>' : '';
  /* 「所有文章」在子菜单里排在「文章」之后；原版结构：主菜单项 + 展开的子菜单 */
  const parts = li.split('</li>');
  const withSub = (key) => {
    const idx = items.findIndex((x) => x[1] === key);
    parts[idx] = parts[idx] + subWrap;
    return parts.join('</li>');
  };
  const body = (active === 'posts' || active === 'dash') ? withSub(active) : li;
  return '<div id="adminmenuwrap"><ul id="adminmenu">' + body + '</ul>'
    + '<div class="collapse"><a href="#">‹ 折叠菜单</a></div></div>';
}

function csShell(title, active, inner, opts) {
  const o = opts || {};
  const notice = '<div class="notice readonly"><p><strong>数据库处于只读模式</strong>：本站点的所有写入操作均已停用。'
    + '您可以浏览内容，但任何更改都不会被保存。</p></div>';
  const foot = '<div class="wpfooter"><span>感谢使用 <a href="#">墨匣</a> 进行创作。</span></div>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>' + CS_CSS + '</style></head><body class="wp-admin wp-core-ui">'
    + csMenu(active)
    + '<div id="wpwrap"><div id="wpcontent">'
    + '<div id="wpadminbar"><div class="ab-left"><span class="siteic">◎</span> '
    + '<a class="site-link" href="' + CS_BASE + '/">和合医疗 Concord Clinic</a>'
    + '  <span class="cmt">0</span>  <span class="addnew">＋ 新建</span></div>'
    + '<div class="ab-right">你好，<strong>jack</strong><span class="avatar"></span></div></div>'
    + '<div class="wrap">' + (o.noNotice ? '' : notice) + inner + '</div>' + foot
    + '</div></div></body></html>';
}

const CS_CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0}',
  'body{background:#f0f0f1;color:#3c434a;font:13px/1.5 ' + CS_FONT + '}',
  'a{color:#2271b1;text-decoration:none}a:hover{color:#135e96}',
  '#adminmenuwrap{position:fixed;left:0;top:0;bottom:0;width:160px;background:#1d2327;color:#f0f0f1;z-index:20}',
  '#adminmenu{list-style:none;margin:0;padding:0}',
  '#adminmenu .menu-top>a{display:block;padding:9px 12px;color:#f0f0f1;font-size:14px}',
  '#adminmenu .menu-top>a:hover{background:#2c3338;color:#72aee6}',
  '#adminmenu .menu-top.current>a{background:#2271b1;color:#fff;font-weight:600}',
  '.subwrap .wp-submenu{list-style:none;margin:0;padding:6px 0;background:#2c3338}',
  '.subwrap .wp-submenu a{display:block;padding:6px 12px 6px 22px;color:#c3c4c7;font-size:13px}',
  '.subwrap .wp-submenu .current a{color:#fff;font-weight:600}',
  '.subwrap .wp-submenu a:hover{color:#72aee6}',
  '#adminmenuwrap .collapse{padding:10px 12px;border-top:1px solid #2c3338}',
  '#adminmenuwrap .collapse a{color:#c3c4c7}',
  '#wpwrap{margin-left:160px;min-height:100vh}',
  '#wpadminbar{height:32px;background:#1d2327;color:#f0f0f1;display:flex;justify-content:space-between;align-items:center;padding:0 14px;font-size:13px}',
  '.site-link{color:#f0f0f1}',
  '#wpadminbar .cmt{background:#d63638;color:#fff;border-radius:9px;padding:0 6px;font-size:11px;margin-left:6px}',
  '#wpadminbar .addnew{margin-left:12px;color:#72aee6}',
  '#wpadminbar .avatar{display:inline-block;width:16px;height:16px;border-radius:50%;background:#50575e;margin-left:8px;vertical-align:middle}',
  '.wrap{padding:12px 20px 40px}',
  '.notice{background:#fff;border:1px solid #c3c4c7;border-left:4px solid #72aee6;padding:9px 12px;margin:12px 0 18px;box-shadow:0 1px 1px rgba(0,0,0,.04)}',
  '.notice.readonly{border-left-color:#dba617}',
  '.notice p{margin:0}',
  'h1.wp-heading-inline{display:inline-block;font-size:23px;font-weight:400;margin:8px 0 12px;color:#1d2327}',
  '.page-title-action{display:inline-block;margin-left:8px;padding:4px 10px;border:1px solid #2271b1;border-radius:3px;color:#2271b1;font-size:13px;vertical-align:middle}',
  '.subsubsub{margin:8px 0 6px;color:#646970;font-size:13px}',
  '.subsubsub li{display:inline;margin:0;padding:0}',
  '.subsubsub li+li:before{content:" | ";color:#a7aaad;padding:0 4px}',
  '.subsubsub .current{font-weight:600;color:#000}',
  '.subsubsub .count{color:#646970}',
  '.tablenav{display:flex;gap:6px;align-items:center;margin:8px 0}',
  '.tablenav select,.tablenav button{padding:2px 8px;font-size:13px;border:1px solid #8c8f94;border-radius:3px;background:#fff}',
  '.tablenav button[disabled]{color:#a7aaad;border-color:#dcdcde}',
  '.wp-list-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #c3c4c7;box-shadow:0 1px 1px rgba(0,0,0,.04)}',
  '.wp-list-table th,.wp-list-table td{text-align:left;padding:10px 12px;border-bottom:1px solid #f0f0f1;vertical-align:top;font-size:13px}',
  '.wp-list-table thead th{border-bottom:1px solid #c3c4c7;font-weight:400;color:#3c434a}',
  '.wp-list-table tbody tr:hover{background:#f6f7f7}',
  '.wp-list-table .column-title{width:46%}',
  '.row-title{font-size:14px;font-weight:600;color:#2271b1}',
  '.sticky-tag{color:#3c434a;font-size:12px;border:1px solid #c3c4c7;border-radius:3px;padding:0 4px;margin-left:4px;vertical-align:1px}',
  '.priv-tag{color:#646970;font-size:12px}',
  '.row-actions{display:block;visibility:hidden;color:#2271b1;font-size:12px;margin-top:3px}',
  '.wp-list-table tbody tr:hover .row-actions{visibility:visible}',
  '.row-actions a{font-size:12px}',
  '.dashicons{margin-right:6px}',
  '.wpfooter{padding:16px 20px;color:#646970;font-size:12px;border-top:1px solid #dcdcde}',
  '.metabox{background:#fff;border:1px solid #c3c4c7;box-shadow:0 1px 1px rgba(0,0,0,.04);margin-bottom:16px}',
  '.metabox h2{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #dcdcde;font-weight:600}',
  '.metabox .inside{padding:12px}',
  '.overview-row{display:flex;gap:26px;font-size:14px;align-items:center}',
  '.credit-line{margin-top:14px;color:#646970}',
  '.edit-flex{display:flex;gap:20px;align-items:flex-start}',
  '.edit-main{flex:1;min-width:0}',
  '.edit-side{width:280px;flex:0 0 280px}',
  '.permalink{color:#646970;font-size:13px;margin:4px 0 10px}',
  '.toolbar{display:flex;gap:8px;align-items:center;border:1px solid #c3c4c7;border-bottom:none;background:#f6f7f7;padding:6px 8px;font-size:13px;color:#50575e}',
  '.toolbar .sep{color:#c3c4c7}',
  '.editorbox{border:1px solid #c3c4c7;background:#fff;padding:0}',
  '.postbody{padding:16px 18px;font:15px/1.95 ' + CS_FONT + ';color:#22201c;max-height:52vh;overflow:auto}',
  '.postbody p{margin:0 0 15px}',
  '.postbody.is-code{font:13px/1.75 ui-monospace,Consolas,\'Courier New\',monospace;white-space:pre;color:#1d2327}',
  '.postbody .missing{color:#646970;font-style:italic}',
  '.editorfoot{display:flex;justify-content:space-between;padding:8px 12px;border-top:1px solid #dcdcde;color:#646970;font-size:12px;background:#fff}',
  '.side-meta{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}',
  '.side-meta .k{color:#646970}',
  '.side-box{border-top:1px solid #f0f0f1;margin-top:10px;padding-top:10px}',
  '.side-box h3{font-size:13px;margin:0 0 6px;color:#1d2327;font-weight:600}',
  '.muted{color:#646970}',
  '.btn{display:inline-block;padding:4px 10px;border:1px solid #2271b1;border-radius:3px;background:#fff;color:#2271b1;font-size:13px}',
  '.side-actions{display:flex;justify-content:space-between;align-items:center;margin-top:10px}',
  '.nav-prev-next{display:flex;justify-content:space-between;margin-top:12px;font-size:13px}',
].join('');

/* ── 页面：仪表盘 ─────────────────────────────────────────────────────────── */
function csDash() {
  const recents = ['8月2日 上午6:31', '8月2日 上午6:14', '8月2日 上午5:58', '8月2日 上午5:22', '8月2日 上午4:51'];
  const acts = recents.map((d) => '<div class="side-meta"><span class="muted">' + d + '</span>'
    + '<a href="#">沉痛悼念杰克·怀特医生，音容宛在</a></div>').join('');
  const inner = '<h1 class="wp-heading-inline">仪表盘</h1>'
    + '<div class="edit-flex" style="margin-top:10px">'
    + '<div class="edit-main"><div class="metabox"><h2>概览</h2><div class="inside">'
    + '<div class="overview-row"><span>✒ <a href="#">12 篇文章</a></span>'
    + '<span>▤ <a href="#">0 个页面</a></span>'
    + '<span>💬 <a href="#">0 条评论</a></span></div>'
    + '<div class="credit-line">墨匣 4.2.1，使用素页主题。</div>'
    + '<div class="credit-line"><a href="#">已要求搜索引擎不索引本站点</a></div>'
    + '</div></div>'
    + '<div class="metabox"><h2>站点健康状态</h2><div class="inside">'
    + '<div style="color:#d63638">● 应尽快改善</div>'
    + '<div class="muted" style="margin-top:6px">站点数据库处于只读模式，写入操作已停用。</div>'
    + '</div></div></div>'
    + '<div class="edit-side"><div class="metabox"><h2>活动</h2><div class="inside">'
    + '<div class="muted" style="margin-bottom:8px">最近修改</div>' + acts
    + '<div class="side-actions"><a class="btn" href="' + CS_BASE + '/admin/posts">查看全部文章</a></div>'
    + '</div></div></div></div>';
  return csShell('仪表盘 ‹ 和合医疗 Concord Clinic — 墨匣', 'dash', inner);
}

/* ── 页面：文章列表 ───────────────────────────────────────────────────────── */
function csPosts() {
  const rows = CS_LIST.map((p) => {
    const title = (p.n > 0 ? ('Day ' + p.n) : p.title) + (p.priv ? ' — <span class="priv-tag">私密</span>' : '');
    const sticky = p.sticky ? '<span class="sticky-tag">置顶</span>' : '';
    const tag = ROW_ACTIONS;
    const dateCell = p.sticky
      ? '<div><strong>已发布</strong></div><div>' + p.date + '</div>'
      : '<div><strong>已发布</strong></div><div>' + p.date + '</div>';
    return '<tr><th scope="row" class="check-column"><input type="checkbox"></th>'
      + '<td class="column-title"><a class="row-title" href="' + CS_BASE + '/admin/post/' + p.id + '">'
      + title + '</a>' + sticky + tag + '</td>'
      + '<td>jack</td><td>未分类</td><td>—</td><td>—</td>'
      + '<td class="column-date">' + dateCell + '</td></tr>';
  }).join('');
  const inner = '<h1 class="wp-heading-inline">文章</h1>'
    + '<a class="page-title-action" href="' + CS_BASE + '/admin/post/new">写文章</a>'
    + '<ul class="subsubsub"><li><a href="#" class="current">全部 <span class="count">(12)</span></a></li>'
    + '<li><a href="#">已发布 <span class="count">(1)</span></a></li>'
    + '<li><a href="#">私密 <span class="count">(11)</span></a></li></ul>'
    + '<div class="tablenav"><select><option>批量操作</option></select>'
    + '<button disabled>应用</button><select><option>全部日期</option></select>'
    + '<button disabled>筛选</button></div>'
    + '<table class="wp-list-table"><thead><tr>'
    + '<td class="check-column"><input type="checkbox"></td>'
    + '<th class="column-title">标题</th><th>作者</th><th>分类目录</th><th>标签</th><th>💬</th><th>日期 ↑</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>'
    + '<div class="tablenav" style="justify-content:flex-end;color:#646970">12 个项目</div>';
  return csShell('文章 ‹ 和合医疗 Concord Clinic — 墨匣', 'posts', inner);
}

/* ── 页面：编辑文章 ───────────────────────────────────────────────────────── */
function csPost(p) {
  const title = (p.n > 0 ? ('Day ' + p.n) : p.title);
  let body;
  if (p.body && p.body.length) {
    body = p.code
      ? '<div class="postbody is-code">' + p.body.map((l) => esc(l)).join('\n') + '</div>'
      : '<div class="postbody">' + p.body.map((t) => '<p>' + mdInline(t) + '</p>').join('') + '</div>';
  } else {
    body = '<div class="postbody"><p class="missing">（该条目的正文在离线存档中已丢失。原站在此条目上仅保留了标题与元数据。）</p></div>';
  }
  const words = p.code ? 791 : (p.body ? p.body.join('').length : 0);
  const prev = CS_LIST[CS_LIST.indexOf(p) - 1];
  const next = CS_LIST[CS_LIST.indexOf(p) + 1];
  const nav = '<div class="nav-prev-next">'
    + (prev ? '<a href="' + CS_BASE + '/admin/post/' + prev.id + '">← 上一篇：'
      + (prev.n > 0 ? ('Day ' + prev.n) : prev.title) + '</a>' : '<span></span>')
    + (next ? '<a href="' + CS_BASE + '/admin/post/' + next.id + '">下一篇：'
      + (next.n > 0 ? ('Day ' + next.n) : next.title) + ' →</a>' : '<span></span>')
    + '</div>';
  const inner = '<h1 class="wp-heading-inline">编辑文章</h1>'
    + '<a class="page-title-action" href="' + CS_BASE + '/admin/post/new">写文章</a>'
    + '<div class="edit-flex" style="margin-top:12px">'
    + '<div class="edit-main">'
    + '<div class="permalink">固定链接：' + CS_BASE + '/?p=' + p.id + ' <a href="#">编辑</a></div>'
    + '<div class="toolbar"><span>段落 ▾</span><span class="sep">|</span><b>B</b><i>I</i>'
    + '<span class="sep">|</span><span>≡</span><span>❝</span>'
    + '<span class="sep">|</span><span>🔗</span><span>⛓</span><span>⊕</span><span>▤</span>'
    + '<span style="margin-left:auto">可视化 | 文本</span></div>'
    + '<div class="editorbox">' + body
    + '<div class="editorfoot"><span>字数：' + words + '</span>'
    + '<span>最后由 <strong>jack</strong> 编辑于 ' + p.date + '</span></div></div>'
    + nav + '</div>'
    + '<div class="edit-side"><div class="metabox"><h2>发布</h2><div class="inside">'
    + '<div class="side-meta"><span class="k">状态：</span><span>已发布 <a href="#">编辑</a></span></div>'
    + '<div class="side-meta"><span class="k">可见性：</span><span>'
    + (p.priv ? '私密 <a href="#">编辑</a>' : '公开 <a href="#">编辑</a>') + '</span></div>'
    + '<div class="side-meta"><span class="k">发布于：</span><span>' + p.date + ' <a href="#">编辑</a></span></div>'
    + '<div class="side-actions"><a href="#" class="btn">移至回收站</a><a href="#" class="btn">更新</a></div>'
    + '</div></div>'
    + '<div class="metabox"><h2>分类目录</h2><div class="inside">'
    + '<div><input type="checkbox"> 未分类</div><div class="muted">+ 添加新分类</div></div></div>'
    + '<div class="metabox"><h2>标签</h2><div class="inside">'
    + '<input placeholder="用半角逗号分隔多个标签。" style="width:100%;padding:3px 6px;border:1px solid #8c8f94;border-radius:3px">'
    + '<div style="text-align:right;margin-top:6px"><button class="btn" disabled>添加</button></div>'
    + '</div></div>'
    + '<div class="metabox"><h2>特色图片</h2><div class="inside"><a href="#">设置特色图片</a></div></div>'
    + '</div></div>';
  return csShell(title + ' ‹ 和合医疗 Concord Clinic — 墨匣', 'posts', inner);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* 仅还原正文里用于强调的 **…**（编辑态观感），其余按纯文本 */
function mdInline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/* ── 路由表 ──────────────────────────────────────────────────────────────── */
const CS_PAGES = {};
function csKey(url) {
  return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
(function csBuild() {
  const add = (url, title, bodyHtml) => {
    const d = {
      url: url,
      supported_locales: ['zh-CN'],
      title: title,
      body_html: bodyHtml,
      allowed_commands: [],
      favicon: CS_FAVICON,
      fonts: CS_FONTS,
    };
    /* ★ data 只放 schema 允许的键（外层 .strict()，多一个键都会被判非法） */
    if (url.indexOf('/admin') >= 0) d.read_fact = 'jack.backend_access';
    CS_PAGES[csKey(url)] = d;
  };
  add(CS_BASE + '/admin', '仪表盘 ‹ 和合医疗 Concord Clinic — 墨匣', csDash());
  add(CS_BASE + '/admin/posts', '文章 ‹ 和合医疗 Concord Clinic — 墨匣', csPosts());
  CS_LIST.forEach((p) => {
    add(CS_BASE + '/admin/post/' + p.id,
      '编辑文章“' + (p.n > 0 ? ('Day ' + p.n) : p.title) + '”‹ 和合医疗 Concord Clinic — 墨匣',
      csPost(p));
  });
})();

/** 取后台页（按完整 URL，与客户端 manifold.artifacts 的 lookup_key 同形） */
function csGet(url) { return CS_PAGES[csKey(url)] || null; }
/** 校验后台密码 */
function csCheckPassword(pw) {
  return String(pw == null ? '' : pw).trim() === CS_PASSWORD;
}

/* ★★★ 客户端 page schema 自检（BrowserPageView 里的 zod，双重 strict）：
 *   z.object({ url, supported_locales, title, body_html, allowed_commands,
 *              favicon?, read_fact?, fonts? }).strict()
 *   fonts: z.array(z.object({ family, url, weight?, style? }).strict())[]
 * 违反者 ⇒ 页面空白 + 反复重拉（且日志里只看到"served"，极具误导性）。
 * ⇒ 在这里静态查一遍，把"白屏"变成"启动即告警"。 */
const SCHEMA_KEYS = ['url', 'supported_locales', 'title', 'body_html',
  'allowed_commands', 'favicon', 'read_fact', 'fonts'];
function csValidatePage(d) {
  const errs = [];
  if (!d || typeof d !== 'object') return ['data 不是对象'];
  Object.keys(d).forEach((k) => { if (SCHEMA_KEYS.indexOf(k) < 0) errs.push('多余键 ' + k); });
  ['url', 'title', 'body_html'].forEach((k) => {
    if (typeof d[k] !== 'string' || !d[k].length) errs.push(k + ' 必须是非空字符串');
  });
  if (!Array.isArray(d.supported_locales) || !d.supported_locales.length
    || d.supported_locales.some((x) => typeof x !== 'string' || !x.length)) {
    errs.push('supported_locales 必须是非空字符串数组');
  }
  if (!Array.isArray(d.allowed_commands)
    || d.allowed_commands.some((x) => typeof x !== 'string' || !x.length)) {
    errs.push('allowed_commands 必须是字符串数组');
  }
  if (d.favicon !== undefined && (typeof d.favicon !== 'string' || !d.favicon.length)) {
    errs.push('favicon 若给必须是非空字符串');
  }
  if (d.read_fact !== undefined && (typeof d.read_fact !== 'string' || !d.read_fact.length)) {
    errs.push('read_fact 若给必须是非空字符串');
  }
  if (d.fonts !== undefined) {
    if (!Array.isArray(d.fonts)) errs.push('fonts 必须是数组');
    else d.fonts.forEach((f, i) => {
      if (!f || typeof f !== 'object') { errs.push('fonts[' + i + '] 不是对象'); return; }
      Object.keys(f).forEach((k) => {
        if (['family', 'url', 'weight', 'style'].indexOf(k) < 0) errs.push('fonts[' + i + '] 多余键 ' + k);
      });
      if (typeof f.family !== 'string' || !f.family.length) errs.push('fonts[' + i + '].family 必填');
      /* ★ 就是这一条漏了会白屏 */
      if (typeof f.url !== 'string' || !f.url.length) errs.push('fonts[' + i + '].url 必填');
    });
  }
  return errs;
}
/** 全量自检，返回 { url: [错误…] }（空对象 = 全通过） */
function csSelfCheck() {
  const bad = {};
  Object.keys(CS_PAGES).forEach((k) => {
    const e = csValidatePage(CS_PAGES[k]);
    if (e.length) bad[k] = e;
  });
  return bad;
}

module.exports = {
  CS_BASE: CS_BASE,
  CS_PASSWORD: CS_PASSWORD,
  CS_URLS: Object.keys(CS_PAGES),
  csGet: csGet,
  csCheckPassword: csCheckPassword,
  csValidatePage: csValidatePage,
  csSelfCheck: csSelfCheck,
  version: 1,
};
