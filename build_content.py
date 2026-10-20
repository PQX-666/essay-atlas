"""Build a traceable, offline content bundle from the user's own study materials.

This script reads original material without modifying it. English body text is
audited against both the original Markdown and structured study notes. Artwork
is converted to full-resolution WebP plus a 400 px thumbnail for the gallery.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
from pathlib import Path

from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DIST = HERE / "dist"
ASSETS = DIST / "assets"
KINDS = ["逐句拆解", "结构解析", "记忆导图", "主题迁移"]
AUDIT: dict = {"articles": [], "images": [], "targetAdjustments": [], "notes": [
    "English article text is taken only from the provided source materials.",
    "CET4 paragraphs follow blank quoted lines in the original Markdown, not logical section boundaries in JSON.",
    "CET6 paragraphs retain the original paragraph translations. Sentence translations are independently translated and matched by exact English text in cet6-sentence-translations.json.",
    "Unverified exam frequency, coverage, prediction, and scoring claims are not included.",
    "All original PNG artwork is retained unmodified. WebP assets are full resolution at quality 88; thumbnails are 400 px wide.",
]}


def norm(text: str) -> str:
    """Ignore punctuation/case/spacing when checking source fidelity."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def clean_label(text: str) -> str:
    return re.sub(r"\*\*【[^】]*】\*\*", "", text).strip()


def extract_cet4_paragraphs(markdown: str) -> list[list[str]]:
    chunks = re.split(r"(?m)^### 第\s*\d+\s*篇：", markdown)[1:]
    result = []
    for chunk in chunks:
        body = re.search(r"#### 范文[^\n]*\n(.*?)(?=\n####|\n---|\Z)", chunk, re.S).group(1)
        groups, lines = [], []
        for line in body.splitlines():
            if not line.startswith(">"):
                continue
            content = clean_label(line[1:].strip())
            if not content:
                # Structural labels should not introduce new paragraphs. Only
                # an actual empty blockquote line establishes a paragraph.
                if not line[1:].strip() and lines:
                    groups.append(lines)
                    lines = []
            else:
                lines.append(content)
        if lines:
            groups.append(lines)
        # Preserve the line breaks in letter closings and report bylines.
        result.append(["\n".join(g) if all(not re.search(r"[.!?]", s) for s in g) else " ".join(g) for g in groups])
    assert len(result) == 10
    return result


def exact_fragment(text: str, candidate: str) -> str | None:
    match = re.search(re.escape(candidate.strip()), text, re.I)
    return match.group(0) if match else None


def meaningful_targets(sentence: dict) -> list[str]:
    candidates = [n["en"] for n in sentence.get("notes", []) if n.get("kind") in ("词块", "句式", "格式")]
    candidates += [h["text"] for h in sentence.get("highlight", []) if h.get("kind") in ("orange", "green")]
    candidates += [n["en"] for n in sentence.get("notes", [])]
    chosen: list[str] = []
    for candidate in candidates:
        actual = exact_fragment(sentence["en"], candidate)
        if not actual or not 2 <= len(actual.split()) <= 10:
            continue
        if any(actual.lower() in prior.lower() or prior.lower() in actual.lower() for prior in chosen):
            continue
        chosen.append(actual)
        if len(chosen) >= 2:
            break
    return chosen


def aligned_paragraphs(originals: list[str], sentences: list[dict]) -> list[dict]:
    """Consume each source sentence exactly once, preserving true paragraphs."""
    paragraphs = []
    cursor = 0
    for original in originals:
        consumed, translations = "", []
        expected = norm(original)
        while consumed != expected:
            assert cursor < len(sentences), original
            sentence = sentences[cursor]
            consumed += norm(sentence["en"])
            assert expected.startswith(consumed), (original, sentence["en"])
            translations.append(sentence["zh"])
            cursor += 1
        paragraphs.append({"en": original, "zh": "".join(translations)})
    assert cursor == len(sentences)
    return paragraphs


def cet4_articles() -> list[dict]:
    markdown = (ROOT / "四级作文10篇背诵范文与模板.md").read_text(encoding="utf-8-sig")
    originals = extract_cet4_paragraphs(markdown)
    structured = []
    for name in ("content_1_3.json", "content_4_7.json", "content_8_10.json"):
        structured.extend(json.loads((ROOT / "制作源文件" / name).read_text(encoding="utf-8-sig")))
    out = []
    for source in sorted(structured, key=lambda a: int(a["id"])):
        number = int(source["id"])
        aid = f"cet4-{number:02}"
        sentences = [{"en": s["en"], "zh": s["zh"], "section": section["label"], "targets": meaningful_targets(s)}
                     for section in source["sections"] for s in section["sentences"]]
        paragraphs = aligned_paragraphs(originals[number - 1], sentences)
        assert norm(" ".join(s["en"] for s in sentences)) == norm(" ".join(p["en"] for p in paragraphs)), aid
        structure = [{"label": b["title"], "summary": b["cue"], "keywords": b["keywords"]}
                     for b in source["memory"]["blocks"]]
        article = {"id": aid, "level": "CET4", "number": number, "title": source["title_zh"],
                   "titleEn": source["title_en"], "genre": source["genre"], "sentences": sentences,
                   "paragraphs": paragraphs, "structure": structure, "images": [],
                   "keywords": list(dict.fromkeys(t for s in sentences for t in s["targets"]))[:12],
                   "transferTip": source["transfer_tip"]}
        out.append(article)
        AUDIT["articles"].append({"id": aid, "source": "四级作文10篇背诵范文与模板.md", "sentences": len(sentences),
                                  "paragraphs": len(paragraphs), "sourceTextMatch": True,
                                  "bodySha256": hashlib.sha256("\n\n".join(p["en"] for p in paragraphs).encode()).hexdigest()})
    return out


# The source's four study phrases sometimes use a dictionary form rather than
# the inflected phrase actually present in the body. Convert only to an exact
# contiguous original span, and record each adjustment in content-audit.json.
CET6_TARGET_FIXES = {
    "keep a record of our progress": "Keeping a record of our progress",
    "take responsibility for our studies": "take greater responsibility for our studies",
    "fulfill our duties": "fulfilling our duties",
    "preserve valuable practices": "preserving valuable practices",
    "reduce unnecessary consumption": "reducing unnecessary consumption",
    "make choices more accessible": "make environmentally friendly choices more accessible",
    "improve facilities": "improving facilities",
    "address a real need": "addressing a real need",
    "make good use of these opportunities": "making good use of these opportunities",
}

# A small number of sentence cues supplement the original four phrases, so
# whole-sentence recall is useful throughout each essay rather than on four
# isolated sentences alone. Every cue is validated against source text.
CET6_CUES = {
    1: ["plays an important role in", "manage our own time", "clear plans and consistent effort", "deal with difficulties", "adjust our methods", "build confidence", "move closer to our goals"],
    2: ["continue learning independently", "clear goals", "choose suitable materials", "active practice", "applying knowledge to new problems", "regularly reflect on our progress", "ask for guidance"],
    3: ["evaluate what we read", "avoid poor decisions", "Checking reliable sources", "understand different viewpoints", "based on reasons rather than emotions", "Reading widely", "responsible Internet users"],
    4: ["relying on it too heavily", "choosing arguments and organizing information", "similar results", "when used thoughtfully", "point out weaknesses", "make our own decisions", "keeping an active role"],
    5: ["work together", "prepares us for future work", "offer support", "listen carefully", "accept useful feedback", "take responsibility for their own tasks", "mutual respect and reliable cooperation"],
    6: ["keeping our promises", "ordinary choices in daily life", "builds trust", "offer help", "solve practical problems", "keeping realistic promises", "consistent and reliable actions"],
    7: ["customs and ideas", "the meaning behind familiar practices", "care and connection", "cultural knowledge supports communication", "examine traditions thoughtfully", "practical activities", "pass on cultural knowledge"],
    8: ["a more balanced university life", "constant comparison with others", "unnecessary worry", "too little time for rest", "express our feelings", "set realistic expectations", "maintain healthier relationships"],
    9: ["choices we make every day", "practical changes in campus life", "a reusable bottle", "prevent waste", "reduce pollution", "maintain them consistently", "individual responsibility"],
    10: ["understanding the needs of society", "solid knowledge and practical skills", "involvement in community life", "guide our future choices", "take our studies seriously", "improve everyday life", "using them responsibly"],
}

CET6_STRUCTURE_CUES = {
    1: [["manage our own time"], ["turn plans into action", "set aside thirty minutes"], ["deal with difficulties", "build confidence"], ["set realistic goals", "Keeping a record of our progress"]],
    2: [["a solid foundation of knowledge", "continue learning independently"], ["clear goals", "choose suitable materials"], ["in their own words", "reveal gaps in understanding"], ["regularly reflect on our progress", "ask for guidance"]],
    3: [["inaccurate or misleading"], ["avoid poor decisions", "Checking reliable sources"], ["examine its evidence", "consider other explanations"], ["trustworthy sources", "Reading widely"]],
    4: [["opportunities for independent thinking"], ["ready-made answers", "lack personal insight"], ["suggest alternative approaches", "point out weaknesses"], ["make our own decisions", "keeping an active role"]],
    5: [["work together"], ["combine different strengths", "a clear division of tasks"], ["prevent misunderstandings", "listen carefully"], ["agree on a common goal", "mutual respect and reliable cooperation"]],
    6: [["keeping our promises", "fulfilling our duties"], ["builds trust", "depend on us"], ["offer help", "strengthen connections between people"], ["according to our time and abilities", "consistent and reliable actions"]],
    7: [["customs and ideas"], ["care and connection"], ["deepen mutual understanding", "preserving valuable practices"], ["practical activities", "with an open mind"]],
    8: [["a more balanced university life"], ["constant comparison with others", "too little time for rest"], ["express our feelings", "from a different perspective"], ["set realistic expectations", "seek professional support"]],
    9: [["choices we make every day"], ["reducing unnecessary consumption", "reduce pollution"], ["make environmentally friendly choices more accessible"], ["maintain them consistently", "improving facilities"]],
    10: [["making good use of these opportunities"], ["solid knowledge and practical skills", "addressing a real need"], ["involvement in community life", "guide our future choices"], ["apply what we learn", "play a constructive role"]],
}


def split_sentences(paragraph: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\"“])", paragraph) if s.strip()]


def section_text(chunk: str, heading: str) -> str:
    return re.search(r"### " + re.escape(heading) + r"\s*\n(.*?)(?=\n### |\n## |\Z)", chunk, re.S).group(1).strip()


def cet6_articles() -> list[dict]:
    markdown = (ROOT / "六级作文10篇背诵范文与模板.md").read_text(encoding="utf-8-sig")
    sentence_translations = json.loads((HERE / "cet6-sentence-translations.json").read_text(encoding="utf-8-sig"))
    chunks = re.split(r"(?m)^## 第(\d+)篇 ([^\n]+)\n", markdown)
    out = []
    for i in range(1, len(chunks), 3):
        number, title, chunk = int(chunks[i]), chunks[i + 1].strip(), chunks[i + 2]
        aid = f"cet6-{number:02}"
        title_en = next(line.strip() for line in chunk.splitlines() if line.strip())
        original = section_text(chunk, "英文正文")
        en_paragraphs = [p.strip() for p in re.split(r"\n\s*\n", original) if p.strip()]
        zh_paragraphs = [p.strip() for p in re.split(r"\n\s*\n", section_text(chunk, "逐段译文")) if p.strip()]
        assert len(en_paragraphs) == len(zh_paragraphs) == 3, aid
        logic = section_text(chunk, "背诵逻辑").split(" → ")
        section_labels = ["提出问题与立论", "解释、例证与论证", "建议与总结"]
        phrases = []
        for line in section_text(chunk, "四个词块").splitlines():
            match = re.match(r"-\s+([\x00-\x7f]+)", line)
            if match:
                phrases.append(match.group(1).strip())
        body = " ".join(en_paragraphs)
        targets = []
        for phrase in phrases:
            actual = exact_fragment(body, phrase)
            if not actual:
                correction = CET6_TARGET_FIXES.get(phrase)
                actual = exact_fragment(body, correction) if correction else None
                assert actual, f"Cannot locate source phrase {aid}: {phrase}"
                AUDIT["targetAdjustments"].append({"id": aid, "studyPhrase": phrase, "exactBodyPhrase": actual})
            targets.append(actual)
        for phrase in CET6_CUES[number]:
            actual = exact_fragment(body, phrase)
            assert actual, f"Invalid supplementary target {aid}: {phrase}"
            targets.append(actual)
        sentences = []
        translations = sentence_translations[aid]
        for pnum, (en, zh) in enumerate(zip(en_paragraphs, zh_paragraphs)):
            for sentence in split_sentences(en):
                sentence_targets = [t for t in targets if t in sentence]
                translation = translations[len(sentences)]
                assert translation["en"] == sentence, (aid, len(sentences), "Translation source mismatch")
                sentences.append({"en": sentence, "zh": translation["zh"],
                                  "section": section_labels[pnum], "targets": sentence_targets})
        assert len(sentences) == len(translations), aid
        assert norm(" ".join(s["en"] for s in sentences)) == norm(original), aid
        structure = []
        for j, part in enumerate(logic):
            cues = [exact_fragment(body, cue) for cue in CET6_STRUCTURE_CUES[number][j]]
            assert all(cues), (aid, part)
            structure.append({"label": part, "summary": part, "keywords": cues})
        paragraphs = [{"en": en, "zh": zh} for en, zh in zip(en_paragraphs, zh_paragraphs)]
        transfer_tip = section_text(chunk, "换题时怎样改").split("**改写练习：**")[0].strip()
        article = {"id": aid, "level": "CET6", "number": number, "title": title,
                   "titleEn": title_en, "genre": "议论文", "sentences": sentences, "paragraphs": paragraphs,
                   "structure": structure, "images": [], "keywords": targets[:12], "transferTip": transfer_tip}
        out.append(article)
        AUDIT["articles"].append({"id": aid, "source": "六级作文10篇背诵范文与模板.md", "sentences": len(sentences),
                                  "paragraphs": len(paragraphs), "sourceTextMatch": True,
                                  "translationScope": "sentence-and-paragraph", "bodySha256": hashlib.sha256(original.encode()).hexdigest()})
    assert len(out) == 10
    return out


def convert_image(job: tuple[dict, str, Path]) -> tuple[str, dict, dict]:
    article, kind, source = job
    image_id = f"{article['id']}-{KINDS.index(kind) + 1:02}"
    name = f"{image_id}.webp"
    thumb_name = f"{image_id}.thumb.webp"
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        width, height = image.size
        image.save(ASSETS / name, "WEBP", quality=88, method=6)
        thumb = image.resize((400, round(height * 400 / width)), Image.Resampling.LANCZOS)
        thumb.save(ASSETS / thumb_name, "WEBP", quality=83, method=6)
    info = {"id": image_id, "kind": kind, "src": f"assets/{name}", "thumb": f"assets/{thumb_name}",
            "width": width, "height": height}
    audit = {"id": image_id, "source": str(source.relative_to(ROOT)), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
             "width": width, "height": height, "fullBytes": (ASSETS / name).stat().st_size,
             "thumbBytes": (ASSETS / thumb_name).stat().st_size}
    return article["id"], info, audit


def main() -> None:
    DIST.mkdir(exist_ok=True)
    ASSETS.mkdir(exist_ok=True)
    articles = cet4_articles() + cet6_articles()
    jobs = []
    for article in articles:
        folder = ROOT / ("CET4_40_Images_手绘生成版" if article["level"] == "CET4" else "CET6_40_Images")
        subdirs = list(folder.glob(f"{article['number']:02}_*"))
        assert len(subdirs) == 1, article["id"]
        for kind in KINDS:
            paths = list(subdirs[0].glob(f"*_{kind}.png"))
            assert len(paths) == 1, (article["id"], kind)
            jobs.append((article, kind, paths[0]))
    assert len(jobs) == 80
    by_id = {a["id"]: a for a in articles}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for aid, image, audit in pool.map(convert_image, jobs):
            by_id[aid]["images"].append(image)
            AUDIT["images"].append(audit)
            print(f"Converted {image['id']}", flush=True)
    for article in articles:
        article["images"].sort(key=lambda img: img["id"])
        assert len(article["images"]) == 4
        assert 3 <= len(article["structure"]) <= 5
        assert sum(len(s["targets"]) for s in article["sentences"]) >= 4
        assert all(target in sentence["en"] for sentence in article["sentences"] for target in sentence["targets"])
    bundle = {"articles": articles}
    (DIST / "data.js").write_text("window.ESSAY_DATA = " + json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    AUDIT["summary"] = {"articleCount": len(articles), "imageCount": len(jobs), "generatedAssetCount": 160,
                         "allEnglishSourceChecksPassed": True, "allTargetSubstringChecksPassed": True,
                         "fullImageBytes": sum(i["fullBytes"] for i in AUDIT["images"]),
                         "thumbnailBytes": sum(i["thumbBytes"] for i in AUDIT["images"])}
    (HERE / "content-audit.json").write_text(json.dumps(AUDIT, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(AUDIT["summary"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
