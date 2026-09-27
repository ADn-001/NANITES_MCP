export function scoreDeterministicRule(output, rule) {
    const text = output.trim();
    switch (rule.type) {
        case "json_valid": {
            try {
                JSON.parse(text);
                return { score: 100, detail: "json_parseable" };
            }
            catch {
                return { score: 0, detail: "json_parse_failed" };
            }
        }
        case "exact_match": {
            const expected = String(rule.params.expected ?? "");
            return text === expected
                ? { score: 100, detail: "exact_match" }
                : { score: 0, detail: `expected "${expected}", got "${text.slice(0, 80)}"` };
        }
        case "label_in_set": {
            const set = rule.params.set ?? [];
            // A committed answer is one of: the whole first line, or its first token.
            const firstLine = text.split(/\r?\n/)[0].trim();
            const firstToken = firstLine.split(/\s+/)[0] ?? "";
            const pass = set.includes(firstLine) || set.includes(firstToken);
            return pass
                ? { score: 100, detail: `label_in_set "${firstLine}"` }
                : { score: 0, detail: `label "${firstLine}" not in ${set.join("|")}` };
        }
        case "regex_match": {
            const pattern = String(rule.params.pattern ?? "");
            try {
                const pass = new RegExp(pattern).test(text);
                return pass
                    ? { score: 100, detail: `regex_match /${pattern}/` }
                    : { score: 0, detail: `no match for /${pattern}/` };
            }
            catch {
                return { score: 0, detail: `invalid regex "${pattern}"` };
            }
        }
        default:
            return { score: 0, detail: `unknown rule type "${String(rule.type)}"` };
    }
}
