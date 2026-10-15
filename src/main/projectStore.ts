/**
 * PROJECT 自己的那一点配置 —— 现在只有一件事：它的工作目录。
 *
 * project 原来**没有任何记录**:它只是 ui-state 里一串名字(`kirolex-projects`),加上磁盘上一个
 * `projects/<名字>/runs/` 目录。而「这摊活在哪个仓库里」是它最该知道的事 —— 「这玩意加到 project 里面
 * 不就好了吗，为什么要加到 flow 里」。
 *
 * 为什么不是 flow：flow 是**定义**,同一套流程要能对 A 仓库跑一遍、对 B 仓库跑一遍;目录一进定义,就得为
 * 每个仓库注册一份,连指纹都变,「同一个定义」这个身份就没了。
 * 为什么不是起跑输入：同一个 project 里这个答案**永远一样**,每次开跑都问一遍就是把常量做成必填项。
 *
 * 文件落在那个 project 已有的目录里(`runs/` 的旁边),所以它跟着 project 的重命名一起搬(`renameProjectRuns`
 * 处理的就是那一层)。
 */
import fs from 'fs';
import path from 'path';
/**
 * project 名 → 目录名。**逐字来自原来的 `runStore.projectDirName`** —— 那个模块属于 flow，
 * 而这里是它唯一还需要的东西，所以就地放一份，不为一个函数留一条跨模块依赖。
 *
 * 不许改写这条规则：它决定 `~/.kirolex/projects/<目录>` 落在哪儿，改一个字符就等于让存量
 * project 的数据"消失"。判据是**白名单**（词字符、点、横线、空格、中日韩），不是黑名单；
 * 开头的点要换掉（`.foo` 会变成隐藏目录）。
 */
function projectDirName(project: string): string {
  return (project || '').trim().replace(/[^\w.\- \u4e00-\u9fff]/g, '_').replace(/^\.+/, '_') || '_';
}

export interface ProjectConfig {
  /**
   * 这个 project 的会话在哪个目录里干活（kiro-cli 的 cwd）。
   *
   * 空 = 家目录。它决定三件事，而**只有第一件**能靠在路径里写绝对路径绕过去：
   *   相对路径落在哪（`aidlc-docs/…`）
   *   shell 命令在哪跑（`npm test` 在家目录里跑就是当场失败）
   *   写入许可的基准目录
   */
  workspace?: string;
}

const configFile = (home: string, project: string) =>
  path.join(home, '.kirolex', 'projects', projectDirName(project), 'project.json');

export function readProject(home: string, project: string): ProjectConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(home, project), 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const workspace = String((raw as any).workspace || '').trim();
    return workspace ? { workspace } : {};
  } catch { return {}; }
}

/** 原子写，和其它 store 一样：半写的配置会让下一次起会话落在一个不存在的目录里。 */
export function writeProject(home: string, project: string, config: ProjectConfig): void {
  const file = configFile(home, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const workspace = String(config?.workspace || '').trim();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(workspace ? { workspace } : {}, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * 这个目录能用吗 —— 说人话的理由，而不是让它在起会话时失败。
 *
 * 只查存在与是不是目录:权限、挂载、符号链接那些交给真正 spawn 的那一刻,在这里假装检查全了反而误导。
 */
export function whyNotWorkspace(dir: string): string | null {
  const want = String(dir || '').trim();
  if (!want) return null;                                  // 空 = 用家目录，合法
  if (!path.isAbsolute(want)) return '要写绝对路径（从 / 开始）';
  try {
    if (!fs.statSync(want).isDirectory()) return '这不是一个目录';
  } catch { return '这个目录不存在'; }
  return null;
}

/** 会话该在哪儿起 —— project 有目录就用它，否则家目录。 */
export function projectCwd(home: string, project: string | undefined | null): string {
  const name = String(project || '').trim();
  if (!name) return home;
  return readProject(home, name).workspace || home;
}
