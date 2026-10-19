"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { effectiveRules, loadHouseRules } from "@/lib/house-rules";

/**
 * 资料 · 玩法与神职能力（2026-10-16 新增）
 * 内容与 src/lib/game-master.ts / src/game/phases/* 的实际实现对齐，
 * 避免与实现不符造成误解（尤其各人数局的真实角色构成、查验与开枪规则）。
 */

interface RulesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FLOW: Array<[string, string]> = [
  ["① 夜晚", "守卫 → 狼人 → 女巫 → 预言家 依次行动（有对应角色的局才会出现）。狼人共同决定刀谁；女巫看到当晚被刀的人后可决定是否用解药，也可另外用毒药。"],
  ["② 天亮公布", "公布当夜死亡者（若首日为「警长竞选日」，死亡结果会等竞选结束后再公布）。"],
  ["③ 警长竞选", "首日有警长竞选：上警的玩家依次发言，再由未上警者投票选出警长；只有 1 人上警时，若场上没有可投票的真人则自动当选，有真人可投票时仍会进入投票确认。警长持有警徽、投票记 1.5 票，出局时可移交或撕毁警徽。"],
  ["④ 白天发言", "从警长下一位开始依次发言，警长最后发言；所有人发言完毕进入投票。"],
  ["⑤ 放逐投票", "全体存活玩家投票，得票最高者被放逐并留下遗言；平票则进 PK 发言后重投。"],
  ["⑥ 循环", "放逐结束后进入下一夜，如此往复直到分出胜负。"],
];

const WIN: Array<[string, string]> = [
  ["好人阵营胜利", "所有狼人（含白狼王）全部出局。"],
  ["狼人阵营胜利", "存活狼人数 ≥ 存活好人数（即「屠城」达成）。"],
];

const ROLES: Array<{ name: string; camp: "village" | "wolf"; desc: string; tips?: string }> = [
  {
    name: "村民",
    camp: "village",
    desc: "没有任何特殊能力，靠发言与投票找出狼人。人数是好人阵营的「票仓」。",
  },
  {
    name: "预言家",
    camp: "village",
    desc: "每晚可查验一名玩家，得知其是「狼人」还是「好人」。白狼王也会被查验为狼人。同一晚只能查验一次，可以重复查验同一个人。",
    tips: "查验结果会即时显示，并在笔记本中记录查验历史。",
  },
  {
    name: "女巫",
    camp: "village",
    desc: "拥有解药与毒药各一瓶，各只能用一次（整局）。解药可救回当晚被狼人击杀的玩家；毒药可毒杀一名玩家。",
    tips: "被毒死的猎人不能开枪；若守卫守护的人同时被女巫用解药救，该玩家仍会死亡（同守同救）。",
  },
  {
    name: "猎人",
    camp: "village",
    desc: "被狼人击杀、被投票放逐、或被白狼王自爆带走时，可以开枪带走一名存活玩家。",
    tips: "被女巫毒死则无法开枪（开枪按钮不会出现）。",
  },
  {
    name: "守卫",
    camp: "village",
    desc: "每晚可守护一名玩家，使其免于当夜狼人的击杀。",
    tips: "不能连续两晚守护同一名玩家；若守护目标与女巫解药救的是同一人，该玩家仍会死亡（同守同救）。",
  },
  {
    name: "白痴",
    camp: "village",
    desc: "被投票放逐时会翻牌亮明身份并免疫这次放逐（不死），但此后失去投票权。",
    tips: "只有 10 人局会出现白痴。",
  },
  {
    name: "狼人",
    camp: "wolf",
    desc: "夜晚与狼队友共同决定击杀一名玩家。白天可以伪装成好人、误导与抗推。",
  },
  {
    name: "白狼王",
    camp: "wolf",
    desc: "狼人阵营。除了参与夜间击杀，还可以在白天发言阶段自爆，并当场带走一名玩家（每局一次）。",
    tips: "被自爆带走的猎人若还能开枪，会立即触发开枪；只有 12 人局会出现白狼王。",
  },
];

const CONFIGS: Array<[string, string, string]> = [
  ["6 人局（快餐局）", "2 狼 2 神 2 民", "神职：预言家、女巫"],
  ["8 人局（经典入门）", "2 狼 3 神 3 民", "神职：预言家、女巫、猎人"],
  ["10 人局（速推局）", "3 狼 4 神 3 民", "神职：预言家、女巫、猎人、白痴"],
  ["12 人局（标准经典 · 默认）", "4 狼 4 神 4 民", "狼队含白狼王；神职：预言家、女巫、猎人、守卫"],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-xs leading-relaxed">
      <span className="shrink-0 w-[76px] font-medium text-[var(--text-secondary)]">{label}</span>
      <span className="text-[var(--text-muted)]">{children}</span>
    </div>
  );
}

export function RulesModal({ open, onOpenChange }: RulesModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 滚动说明：DialogContent 基类是 grid，此前叠加 flex+overflow-hidden 导致内容溢出且无法滚动；
          现改为与 SettingsModal 相同的做法 —— 滚动交给 DialogContent 自身（max-h + overflow-y-auto） */}
      <DialogContent className="w-[92vw] max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-[var(--text-primary)]">资料 · 玩法与神职能力</DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            开局前先看一眼，规则与技能都在这里
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pb-2">
          {/* 特殊规则：最容易踩坑的几条，放最前面（免得像之前那样翻不到） */}
          <div className="rounded-lg border-2 border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5">
            <div className="text-xs font-medium text-amber-500">
              当前规则：{effectiveRules(loadHouseRules()).enabled ? "自定义" : "标准"}（可在「游戏设置 → 规则配置」中自定义）
            </div>
            <div className="text-xs font-medium text-amber-500">容易踩坑的特殊规则</div>
            <ul className="text-xs leading-relaxed text-[var(--text-muted)] space-y-1">
              <li>
                · <b className="text-[var(--text-primary)]">同守同救必死</b>：守卫守护的人，与女巫用解药救的人
                是同一名玩家时，这名玩家<b className="text-[var(--text-primary)]">仍然会死亡</b>
                （主流狼人杀规则，俗称「奶穿」）。看着不合理，但确实是标准判定。
              </li>
              <li>
                · <b className="text-[var(--text-primary)]">同守同毒必死</b>：被守卫守护的人若同时被女巫下毒，同样死亡。
              </li>
              <li>· <b className="text-[var(--text-primary)]">被毒死的猎人不能开枪</b>（其他死法都可以开枪）。</li>
              <li>· <b className="text-[var(--text-primary)]">守卫不能连续两晚守护同一人</b>。</li>
              <li>· <b className="text-[var(--text-primary)]">白痴翻牌后失去投票权</b>。</li>
            </ul>
          </div>

          <Section title="一局怎么走">
              <div className="space-y-2">
                {FLOW.map(([k, v]) => (
                  <Row key={k} label={k}>{v}</Row>
                ))}
              </div>
            </Section>

            <Section title="胜利条件">
              <div className="space-y-2">
                {WIN.map(([k, v]) => (
                  <Row key={k} label={k}>{v}</Row>
                ))}
              </div>
            </Section>

            <Section title="好人阵营">
              <div className="space-y-2">
                {ROLES.filter((r) => r.camp === "village").map((r) => (
                  <div key={r.name} className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-2.5 space-y-1">
                    <div className="text-xs font-medium text-[var(--color-seer)]">{r.name}</div>
                    <div className="text-xs leading-relaxed text-[var(--text-muted)]">{r.desc}</div>
                    {r.tips && (
                      <div className="text-[11px] leading-relaxed text-[var(--text-muted)] opacity-80">
                        提示：{r.tips}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            <Section title="狼人阵营">
              <div className="space-y-2">
                {ROLES.filter((r) => r.camp === "wolf").map((r) => (
                  <div key={r.name} className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-2.5 space-y-1">
                    <div className="text-xs font-medium text-[var(--color-wolf)]">{r.name}</div>
                    <div className="text-xs leading-relaxed text-[var(--text-muted)]">{r.desc}</div>
                    {r.tips && (
                      <div className="text-[11px] leading-relaxed text-[var(--text-muted)] opacity-80">
                        提示：{r.tips}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            <Section title="各人数局的角色构成">
              <div className="rounded-lg border-2 border-[var(--border-color)] overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                      <th className="text-left font-medium px-2.5 py-1.5">人数</th>
                      <th className="text-left font-medium px-2.5 py-1.5">构成</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONFIGS.map(([n, comp, note]) => (
                      <tr key={n} className="border-t border-[var(--border-color)]">
                        <td className="px-2.5 py-1.5 align-top text-[var(--text-primary)] whitespace-nowrap">{n}</td>
                        <td className="px-2.5 py-1.5 text-[var(--text-muted)]">
                          <div>{comp}</div>
                          <div className="text-[11px] opacity-80">{note}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
