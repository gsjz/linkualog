import json
import os
import glob
import shutil

DATA_DIR = os.environ.get("DATA_DIR", "../data")
OUTPUT_DIR = "docs/dictionary"
TAGS_MAP_PATH = "hooks/tags.json" 

def generate_pages():
    if os.path.exists(OUTPUT_DIR):
        shutil.rmtree(OUTPUT_DIR)
        
    tags_map = {}
    if os.path.exists(TAGS_MAP_PATH):
        with open(TAGS_MAP_PATH, "r", encoding="utf-8") as f:
            try:
                tags_map = json.load(f)
            except json.JSONDecodeError:
                print(f"⚠️ [Hook警告] {TAGS_MAP_PATH} 格式错误，将使用原文件夹名。")
                
    json_files = glob.glob(os.path.join(DATA_DIR, '**', '*.json'), recursive=True)
    count = 0
    category_index = {}
    
    for json_path in json_files:
        rel_path = os.path.relpath(json_path, DATA_DIR)
        category = os.path.dirname(rel_path)
        
        with open(json_path, "r", encoding="utf-8") as f:
            try:
                item = json.load(f)
            except json.JSONDecodeError:
                continue
                
        word = item.get("word", "unknown")
        tags = item.get("tags", [])
        
        if category:
            dataset_tag = tags_map.get(category, category)
            if dataset_tag not in tags:
                tags.append(dataset_tag)
        
        md = "---\n"
        if tags:
            md += "tags:\n"
            for tag in tags:
                md += f"  - {tag}\n"
        md += "---\n\n"
        
        md += f"# {word}\n\n"
        
        created_at = item.get("createdAt", "")
        reviews = item.get("reviews", [])
        
        if created_at or reviews:
            md += '??? info "学习数据"\n'
            
            if created_at:
                md += f'    - **初次记录**: `{created_at}`\n'
                
            if reviews:
                md += f'    - **复习历史**:\n'
                for r in reviews:
                    r_date = r.get("date", "未知时间")
                    r_score = r.get("score", 0)
                    stars = "⭐" * int(r_score) if isinstance(r_score, (int, float)) else r_score
                    md += f'        - `{r_date}` ｜ 难度: {stars} (分数: {r_score})\n'
            md += '\n'

        pronunciation = item.get("pronunciation", "")
        definitions = item.get("definitions", [])
        
        if pronunciation or definitions:
            md += '??? abstract "释义"\n'
            if pronunciation:
                md += f'    **读音**: `{pronunciation}`\n\n'
            if definitions:
                for d in definitions: 
                    md += f'    - {d}\n'
            md += '\n'
            
        for idx, ex in enumerate(item.get("examples", []), 1):
            text = ex.get("text", "")
            for fw in ex.get("focusWords", []): 
                text = text.replace(fw, f"**{fw}**")
                
            md += f'!!! quote "例句 {idx}"\n    {text}\n\n'

            if "youtube" in ex:
                yt = ex["youtube"]
                sec = yt.get("timestamp", 0)
                mins, secs = divmod(sec, 60)
                jump_url = f"{yt['url']}{'&' if '?' in yt['url'] else '?'}t={sec}s"
                md += f'    :simple-youtube: [在 YouTube 上观看 ({mins}:{secs:02d})]({jump_url}){{: target="_blank" }}\n\n'

            if "source" in ex:
                src = ex["source"]
                src_text = src.get("text", "未知来源")
                src_url = src.get("url", "")
                
                if src_url:
                    md += f'    :lucide-external-link: [来源: {src_text}]({src_url}){{: target="_blank" }}\n\n'
                else:
                    md += f'    :lucide-bookmark: 来源: {src_text}\n\n'

            explanation = ex.get("explanation", "")
            if explanation:
                md += f'    ??? note "解析"\n'
                md += f'        {explanation}\n\n'
            
        cat_out_dir = os.path.join(OUTPUT_DIR, category) if category else OUTPUT_DIR
        os.makedirs(cat_out_dir, exist_ok=True)
        filename = f"{word.lower().replace(' ', '-')}.md"
        with open(os.path.join(cat_out_dir, filename), "w", encoding="utf-8") as out:
            out.write(md)
            
        if category not in category_index:
            category_index[category] = []
        category_index[category].append({"word": word, "file": filename})
        count += 1

    for cat, words in category_index.items():
        cat_out_dir = os.path.join(OUTPUT_DIR, cat) if cat else OUTPUT_DIR
        title = tags_map.get(cat, cat) if cat else "全部"
        
        if cat.lower() == 'daily':
            nav_icon = "lucide/calendar-days"
        elif cat.lower() == 'cet':
            nav_icon = "lucide/graduation-cap"
        elif cat.lower() == 'ielts':
            nav_icon = "lucide/file-badge"
        else:
            nav_icon = "lucide/folder"
            
        index_md = f"---\nicon: {nav_icon}\n---\n\n"
        index_md += f"# :lucide-library: {title} 词汇合集\n\n"
        index_md += "点击下方列表进入对应的词汇详情页：\n\n"
        
        for w in sorted(words, key=lambda x: x["word"].lower()):
            index_md += f"- [{w['word']}]({w['file']})\n"
            
        with open(os.path.join(cat_out_dir, "index.md"), "w", encoding="utf-8") as out:
            out.write(index_md)
            
    print(f"✅ 成功生成 {count} 个单词页面，并为 {len(category_index)} 个分类创建了聚合主页！")

if __name__ == "__main__":
    generate_pages()