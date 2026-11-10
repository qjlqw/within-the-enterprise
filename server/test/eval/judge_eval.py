"""
DeepEval judge 评测脚本（第 2 步）

职责：
  1. 读取最新的 agent-evaluation 产物（.artifacts/agent-evaluation-*.json，含 evidence 上下文）
  2. 用 judge 模型打三类指标：忠实度（Faithfulness）、幻觉（Hallucination）、答案相关性（AnswerRelevancy）
  3. --calibrate N：导出 N 条样本为人工校准清单（judge 只做趋势监控，必须定期人工校准）

用法：
  python test/eval/judge_eval.py                     # 全量 judge 打分
  python test/eval/judge_eval.py --report xxx.json   # 指定报告
  python test/eval/judge_eval.py --limit 5           # 只跑前 N 条（试跑）
  python test/eval/judge_eval.py --calibrate 20      # 导出 20 条人工校准清单（无需安装 deepeval）

Judge 模型（优先级从高到低）：
  JUDGE_MODEL / JUDGE_BASE_URL / JUDGE_API_KEY 环境变量
  -> server/.env 的 LLM_MODEL / LLM_BASE_URL / LLM_API_KEY（自动解析，无需手动 export）
注意：judge 与被评 Agent 同模型有自我偏好偏差，正式验收必须用独立 judge 模型。
"""
import argparse
import glob
import json
import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # server/
REPO_ROOT = Path(__file__).resolve().parents[3]  # 仓库根：.artifacts 在这里
ARTIFACT_DIR = REPO_ROOT / ".artifacts"
ENV_FILE = ROOT / ".env"


def load_env_fallback():
    """从 server/.env 读 LLM_* 到 os.environ（不覆盖已有值），避免依赖 python-dotenv"""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def find_latest_report():
    # 优先完整评测报告，其次 smoke 报告（--smoke 模式也会写 evidence）
    for pattern in ("agent-evaluation-*.json", "agent-smoke-*.json"):
        files = sorted(
            glob.glob(str(ARTIFACT_DIR / pattern)),
            key=os.path.getmtime,
            reverse=True,
        )
        if files:
            return files[0]
    sys.exit(f"未找到 {ARTIFACT_DIR} 下的 agent-evaluation/agent-smoke 报告，先跑 npm run eval:agent")


def load_cases(report_path):
    """提取可判分用例：completed + 有 answer + 检索证据非空（judge 指标必须吃 chunk 原文）"""
    data = json.loads(Path(report_path).read_text(encoding="utf-8"))
    cases = []
    for item in data.get("results", []):
        if item.get("status") == "failed" or not item.get("answer"):
            continue
        contexts = [
            (c.get("text") or "").strip()
            for c in (item.get("evidence") or [])
            if (c.get("text") or "").strip()
        ]
        if not contexts:
            continue
        cases.append(
            {
                "id": item.get("id"),
                "input": item.get("question"),
                "actual_output": item.get("answer"),
                "expected_output": item.get("expected") or None,
                "retrieval_context": contexts,
            }
        )
    return cases


def export_calibration(cases, n, out_path):
    """人工校准清单：judge 每轮打分后抽样人工复核，校准 judge 的一致性"""
    sample = random.sample(cases, min(n, len(cases)))
    with open(out_path, "w", encoding="utf-8") as f:
        for c in sample:
            f.write(
                json.dumps(
                    {
                        "id": c["id"],
                        "question": c["input"],
                        "expected": c["expected_output"],
                        "answer": c["actual_output"],
                        "evidenceDocCount": len(c["retrieval_context"]),
                        # 人工填写：目标达成 0/1、无幻觉 0/1、引用合理 0/1、备注
                        "human_goal": "",
                        "human_no_hallucination": "",
                        "human_citation_ok": "",
                        "human_note": "",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    print(f"人工校准清单已导出 {len(sample)} 条 -> {out_path}")
    print("请逐条填写 human_goal / human_no_hallucination / human_citation_ok（0/1），")
    print("再与 judge 同批次的分数对比一致率；一致率 < 80% 时需调整 judge 模型或阈值。")


def build_judge_model():
    """自定义 DeepEval 模型：走现有 DashScope 兼容网关，避免依赖 OpenAI 官方 key"""
    model = os.getenv("JUDGE_MODEL") or os.getenv("LLM_MODEL")
    base_url = os.getenv("JUDGE_BASE_URL") or os.getenv("LLM_BASE_URL")
    api_key = os.getenv("JUDGE_API_KEY") or os.getenv("LLM_API_KEY")
    if not (model and base_url and api_key):
        sys.exit("缺少 judge 配置：需要 JUDGE_MODEL/LLM_MODEL、JUDGE_BASE_URL/LLM_BASE_URL、JUDGE_API_KEY/LLM_API_KEY")
    if not os.getenv("JUDGE_MODEL") and os.getenv("LLM_MODEL"):
        print("[警告] judge 与被评 Agent 使用同一模型（自我偏好偏差，分数仅作趋势参考）")

    from openai import OpenAI
    from deepeval.models import DeepEvalBaseLLM

    class GatewayJudge(DeepEvalBaseLLM):
        def __init__(self, name, url, key):
            self._name = name
            self._client = OpenAI(base_url=url, api_key=key)
            super().__init__()

        def load_model(self, *args, **kwargs):
            return self._client

        def generate(self, prompt, schema=None):
            resp = self._client.chat.completions.create(
                model=self._name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
            return resp.choices[0].message.content or ""

        async def a_generate(self, prompt, schema=None):
            return self.generate(prompt, schema)

        def get_model_name(self):
            return self._name

    print(f"judge 模型: {model} @ {base_url}")
    return GatewayJudge(model, base_url, api_key)


def run_judge(cases, report_path):
    from deepeval import evaluate
    from deepeval.metrics import (
        AnswerRelevancyMetric,
        FaithfulnessMetric,
        HallucinationMetric,
    )
    from deepeval.test_case import LLMTestCase

    judge = build_judge_model()
    metrics = [
        FaithfulnessMetric(threshold=0.7, model=judge),
        HallucinationMetric(threshold=0.3, model=judge),
        AnswerRelevancyMetric(threshold=0.7, model=judge),
    ]

    results = []
    for c in cases:
        tc = LLMTestCase(
            input=c["input"],
            actual_output=c["actual_output"],
            expected_output=c["expected_output"],
            retrieval_context=c["retrieval_context"],
            context=c["retrieval_context"],
        )
        row = {"id": c["id"]}
        for m in metrics:
            try:
                m.measure(tc)
                row[m.__class__.__name__] = {"score": m.score, "success": m.success, "reason": m.reason}
            except Exception as exc:  # 单条失败不阻断整体
                row[m.__class__.__name__] = {"error": str(exc)[:300]}
        results.append(row)
        done = {k: v.get("score") for k, v in row.items() if k != "id"}
        print(f"[{c['id']}] {done}")

    summary = {}
    for name in ("FaithfulnessMetric", "HallucinationMetric", "AnswerRelevancyMetric"):
        scores = [r[name]["score"] for r in results if name in r and "score" in r[name]]
        errors = [r[name]["error"] for r in results if name in r and "error" in r[name]]
        summary[name] = {
            "avgScore": round(sum(scores) / len(scores), 4) if scores else None,
            "passRate": (
                round(sum(1 for r in results if r.get(name, {}).get("success")) / len(results), 4)
                if results
                else None
            ),
            "errors": len(errors),
        }

    out = ARTIFACT_DIR / f"judge-{Path(report_path).stem}-{int(Path(report_path).stat().st_mtime)}.json"
    out.write_text(
        json.dumps(
            {"source": str(report_path), "judgeModel": judge.get_model_name(), "summary": summary, "results": results},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print("\n[judge summary]", json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Judge report: {out}")


def main():
    parser = argparse.ArgumentParser(description="DeepEval judge 评测")
    parser.add_argument("--report", help="指定 agent-evaluation 报告路径，默认取最新")
    parser.add_argument("--limit", type=int, default=None, help="只判前 N 条")
    parser.add_argument("--calibrate", type=int, default=None, metavar="N", help="导出 N 条人工校准清单后退出")
    args = parser.parse_args()

    load_env_fallback()
    report_path = args.report or find_latest_report()
    cases = load_cases(report_path)
    print(f"报告: {report_path}，可判分用例 {len(cases)} 条")

    if args.calibrate:
        out = ARTIFACT_DIR / f"calibration-{random.randint(1000, 9999)}.jsonl"
        export_calibration(cases, args.calibrate, out)
        return

    if not cases:
        sys.exit("没有可判分用例（全部 failed 或无检索证据）")
    if args.limit:
        cases = cases[: args.limit]
    run_judge(cases, report_path)


if __name__ == "__main__":
    main()
