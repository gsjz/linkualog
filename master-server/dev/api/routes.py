import os
import mimetypes
import traceback
import glob
import re
import copy
from typing import List
from fastapi import APIRouter, UploadFile, File, Form, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from core.config import get_config_data, save_config_data
from core.storage import save_temp_file
from core.tasks import load_tasks, save_tasks, create_task
from services.llm import process_image, process_word_definition, process_context_analysis
from core.vocabulary import merge_or_create_vocab, VOCAB_DIR, load_vocab

router = APIRouter()


def _tokenize_focus_text(text: str):
    parts = re.split(r"\s+", str(text or "").strip())
    tokens = []
    for part in parts:
        cleaned = re.sub(r"^[^\w]+|[^\w]+$", "", part, flags=re.UNICODE)
        if cleaned:
            tokens.append(cleaned)
    return tokens


def _normalize_focus_positions(raw_focus, token_count: int | None = None):
    if not isinstance(raw_focus, list):
        return []

    normalized = []
    seen = set()
    for item in raw_focus:
        try:
            idx = int(item)
        except (TypeError, ValueError):
            continue
        if idx < 0:
            continue
        if token_count is not None and idx >= token_count:
            continue
        if idx in seen:
            continue
        seen.add(idx)
        normalized.append(idx)
    normalized.sort()
    return normalized


def _normalize_mark_focus(mark: dict, short_mode: bool = False):
    if not isinstance(mark, dict):
        return mark

    next_mark = copy.deepcopy(mark)
    context_value = next_mark.get("c" if short_mode else "context", "")
    token_count = len(_tokenize_focus_text(context_value))
    token_count = token_count if token_count > 0 else None

    focus_positions = _normalize_focus_positions(
        next_mark.get("focusPosition", next_mark.get("focusPositions", next_mark.get("fp", next_mark.get("fps")))),
        token_count=token_count
    )

    if short_mode:
        if focus_positions:
            next_mark["fp"] = focus_positions
            next_mark["fps"] = focus_positions
        else:
            next_mark.pop("fp", None)
            next_mark.pop("fps", None)
        next_mark.pop("focusPosition", None)
        next_mark.pop("focusPositions", None)
    else:
        if focus_positions:
            next_mark["focusPosition"] = focus_positions
            next_mark["focusPositions"] = focus_positions
        else:
            next_mark.pop("focusPosition", None)
            next_mark.pop("focusPositions", None)
        next_mark.pop("fp", None)
        next_mark.pop("fps", None)

    return next_mark


def _normalize_parsed_result_focus(parsed_result):
    if not isinstance(parsed_result, dict):
        return parsed_result

    next_result = copy.deepcopy(parsed_result)
    if isinstance(next_result.get("marked_text"), list):
        next_result["marked_text"] = [
            _normalize_mark_focus(item, short_mode=False) for item in next_result["marked_text"]
            if isinstance(item, dict)
        ]
    if isinstance(next_result.get("m"), list):
        next_result["m"] = [
            _normalize_mark_focus(item, short_mode=True) for item in next_result["m"]
            if isinstance(item, dict)
        ]
    return next_result


def _normalize_task_focus_fields(task):
    if not isinstance(task, dict):
        return task

    next_task = copy.deepcopy(task)
    sub_tasks = next_task.get("sub_tasks", [])
    if not isinstance(sub_tasks, list):
        return next_task

    for sub in sub_tasks:
        if not isinstance(sub, dict):
            continue
        parsed_result = sub.get("parsed_result")
        if isinstance(parsed_result, dict):
            sub["parsed_result"] = _normalize_parsed_result_focus(parsed_result)
    return next_task

@router.get("/api/config")
def get_config():
    config = get_config_data()
    return {
        "provider": config["provider"],
        "model": config["model"],
        "hasKey": config["hasKey"],
        "experimentalCoordinatesEnabled": bool(config.get("experimental_coordinates_enabled"))
    }

@router.post("/api/config")
def update_config(
    provider: str = Form(...),
    model: str = Form(...),
    api_key: str = Form(""),
    experimental_coordinates_enabled: bool | None = Form(None)
):
    save_config_data(provider, model, api_key, experimental_coordinates_enabled)
    return {"status": "success", "message": "配置已保存"}


def process_task_background(task_id: str):
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task: 
        return
    
    task["status"] = "processing"
    save_tasks(tasks)

    for sub in task["sub_tasks"]:
        if sub.get("status") == "completed": 
            continue
        
        try:
            if not os.path.exists(sub["path"]):
                raise FileNotFoundError(f"找不到本地文件: {sub['path']}")
                
            with open(sub["path"], "rb") as f: 
                image_bytes = f.read()
            
            mime = mimetypes.guess_type(sub["path"])[0] or "image/jpeg"
            runtime_config = get_config_data()
            reply = process_image(
                image_bytes,
                os.path.basename(sub["path"]),
                mime,
                experimental_coordinates=bool(runtime_config.get("experimental_coordinates_enabled"))
            )
            
            sub["result"] = reply["raw"]
            sub["parsed_result"] = reply["parsed"]
            sub["result_meta"] = reply.get("meta", {})
            sub["status"] = "completed"
            sub.pop("error", None)
            task["completed"] += 1
            save_tasks(tasks)
            
        except Exception as e:
            print(f"\n❌ [后台任务] 任务 {task_id} 处理子项异常!")
            traceback.print_exc()
            sub["status"] = "failed"
            sub["error"] = str(e)
            task["status"] = "paused"
            save_tasks(tasks)
            return

    task["status"] = "finished"
    save_tasks(tasks)


@router.post("/api/upload_resource")
async def upload_resource(
    background_tasks: BackgroundTasks, 
    files: List[UploadFile] = File(...),
    taskName: str = Form(""),    
    startPage: int = Form(1)
):
    sub_tasks_paths = []
    try:
        for file in files:
            bytes_data = await file.read()
            saved_path = save_temp_file(bytes_data, file.filename)
            
            if file.filename.lower().endswith(".pdf"):
                try:
                    from pdf2image import convert_from_path
                    pdf_images = convert_from_path(saved_path)
                    for i, img in enumerate(pdf_images):
                        img_path = f"{saved_path}_page_{i}.jpg"
                        img.save(img_path, "JPEG")
                        sub_tasks_paths.append(img_path)
                except Exception as pdf_error:
                    raise Exception(f"PDF 解析失败，请检查服务器 poppler 配置: {str(pdf_error)}")
            else:
                sub_tasks_paths.append(saved_path)

        final_name = taskName.strip() if taskName.strip() else "资源解析任务"
        task_id = create_task(
            final_name,
            sub_tasks_paths,
            startPage
        )
        background_tasks.add_task(process_task_background, task_id)
        
        return {"status": "success", "task_id": task_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/task/{task_id}")
def get_task_status(task_id: str):
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task:
        return {"error": "任务不存在"}
    return _normalize_task_focus_fields(task)

@router.post("/api/task/{task_id}/resume")
def resume_task(task_id: str, background_tasks: BackgroundTasks):
    background_tasks.add_task(process_task_background, task_id)
    return {"status": "resumed"}

@router.get("/api/tasks")
def list_all_tasks():
    tasks_dict = load_tasks()
    task_list = []
    for task_id, task_info in tasks_dict.items():
        task_list.append({
            "id": task_id,
            "name": task_info.get("name", "未命名任务"),
            "status": task_info.get("status", "unknown"),
            "total": task_info.get("total", 0),
            "completed": task_info.get("completed", 0)
        })
    task_list.reverse()
    return {"status": "success", "tasks": task_list}

@router.get("/api/image")
def get_image(path: str):
    abs_path = os.path.abspath(path)
    if os.path.exists(abs_path):
        return FileResponse(abs_path)
    return {"error": "图片文件不存在或已被清理"}

@router.delete("/api/task/{task_id}")
def delete_task(task_id: str):
    tasks = load_tasks()
    if task_id in tasks:
        del tasks[task_id]
        save_tasks(tasks)
        return {"status": "success"}
    return {"error": "任务不存在"}

class RegenerateRequest(BaseModel):
    index: int 

class TaskRenameRequest(BaseModel):
    name: str


class TaskPageParsedResultRequest(BaseModel):
    parsed_result: dict

@router.patch("/api/task/{task_id}")
def rename_task(task_id: str, req: TaskRenameRequest):
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    final_name = req.name.strip() if req.name and req.name.strip() else "资源解析任务"
    task["name"] = final_name
    save_tasks(tasks)
    return {"status": "success", "name": final_name}


@router.patch("/api/task/{task_id}/page/{index}/parsed_result")
def update_task_page_parsed_result(task_id: str, index: int, req: TaskPageParsedResultRequest):
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    sub_tasks = task.get("sub_tasks", [])
    if index < 0 or index >= len(sub_tasks):
        raise HTTPException(status_code=400, detail="参数错误，索引越界")

    normalized_result = _normalize_parsed_result_focus(req.parsed_result)
    sub_tasks[index]["parsed_result"] = normalized_result
    save_tasks(tasks)
    return {"status": "success", "parsed_result": normalized_result}

@router.post("/api/task/{task_id}/regenerate")
def regenerate_task_item(task_id: str, req: RegenerateRequest, background_tasks: BackgroundTasks):
    tasks = load_tasks()
    task = tasks.get(task_id)
    if not task:
        return {"error": "任务不存在"}
        
    sub_tasks = task.get("sub_tasks", [])
    if req.index < 0 or req.index >= len(sub_tasks):
        return {"error": "参数错误，索引越界"}
        
    sub = sub_tasks[req.index]
    if sub.get("status") == "completed":
        task["completed"] = max(0, task.get("completed", 1) - 1)
        
    sub["status"] = "pending" 
    sub["result"] = None
    sub.pop("parsed_result", None)
    sub.pop("result_meta", None)
    if "error" in sub:
        del sub["error"]
        
    task["status"] = "processing"
    save_tasks(tasks)
    
    background_tasks.add_task(process_task_background, task_id)
    return {"status": "success", "message": f"已将第 {req.index} 项加入重新生成队列"}

class VocabAddRequest(BaseModel):
    word: str
    context: str = ""
    source: str = ""
    fetch_llm: bool = False
    fetch_type: str = "all" 
    category: str = ""
    focus_positions: list[int] = []
    llm_result: dict = {}  
    youtube: dict = {}    

@router.post("/api/vocabulary/parse")
def parse_vocabulary(req: VocabAddRequest):
    try:
        if req.fetch_type == "def" or not req.context:
            llm_result = process_word_definition(req.word)
        else:
            llm_result = process_context_analysis(req.word, req.context)
        return {"status": "success", "data": llm_result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/vocabulary/categories")
def list_categories():
    categories = []
    if os.path.exists(VOCAB_DIR):
        categories = [d for d in os.listdir(VOCAB_DIR) if os.path.isdir(os.path.join(VOCAB_DIR, d))]
    return {"status": "success", "categories": categories}

@router.post("/api/vocabulary/add")
def add_vocabulary(req: VocabAddRequest):
    try:
        llm_result = req.llm_result or {}
        
        if req.fetch_llm:
            print(f"正在处理 {req.word} | 类型: {req.fetch_type} | 目录: {req.category}")            
            if req.fetch_type == "def" or not req.context:
                llm_result = process_word_definition(req.word)
            else:
                llm_result = process_context_analysis(req.word, req.context) 
        
        final_data = merge_or_create_vocab(
            word=req.word, 
            context=req.context, 
            source_name=req.source, 
            llm_generated_data=llm_result, 
            category=req.category,
            focus_positions=req.focus_positions,
            youtube=req.youtube 
        )
        return {"status": "success", "data": final_data}
    except Exception as e:
        print(f"❌ 生词处理失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/vocabulary/list")
def list_vocabulary(category: str = ""):
    words = []
    safe_category = re.sub(r'[^\w\u4e00-\u9fa5\.-]+', '_', category.strip()) if category else ""
    target_dir = os.path.join(VOCAB_DIR, safe_category) if safe_category else VOCAB_DIR
    
    if os.path.exists(target_dir):
        files = glob.glob(f"{target_dir}/*.json")
        for f in files:
            word = os.path.basename(f).replace(".json", "")
            words.append(word)
    words.sort()
    return {"status": "success", "words": words}

@router.get("/api/vocabulary/detail/{word}")
def get_vocab_detail(word: str, category: str = ""):
    data = load_vocab(word, category)
    if not data:
        return {"error": "单词不存在或已删除"}
    return {"status": "success", "data": data}
