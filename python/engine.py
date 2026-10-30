import sys
import json
import os
import base64
import tempfile

import cv2
import numpy as np

MIN_CONTOUR_AREA = 1000
APPROX_EPSILON_RATIO = 0.002
BRIGHT_THRESHOLD = 180


def _base_dir():
    """Папка, рядом с которой лежат engine.py/engine.exe и bubbles_detect.pt."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _read_image(image_path):
    # np.fromfile + imdecode корректно работают с кириллическими путями на Windows
    data = np.fromfile(image_path, dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def _contours_to_subpaths(contours, min_area=MIN_CONTOUR_AREA):
    """Превращает контуры OpenCV в subpaths для PhotoCraft (shape.create)."""
    subpaths = []
    for cnt in contours:
        if cv2.contourArea(cnt) <= min_area:
            continue
        eps = max(1.0, APPROX_EPSILON_RATIO * cv2.arcLength(cnt, True))
        pts = cv2.approxPolyDP(cnt, eps, True).reshape(-1, 2)
        if len(pts) < 3:
            continue
        subpaths.append({"closed": True, "knots": pts.astype(int).tolist()})
    return subpaths


def process_image(image_path, points, tolerance, output_svg_path):
    """Обрабатывает картинку и сохраняет SVG. Возвращает маску и контуры."""
    try:
        img = _read_image(image_path)
        if img is None:
            return {"error": "Не удалось открыть картинку"}

        blurred = cv2.GaussianBlur(img, (3, 3), 0)
        h, w = blurred.shape[:2]
        mask = np.zeros((h + 2, w + 2), np.uint8)
        im_floodfill = blurred.copy()

        lo_diff = up_diff = (int(tolerance),) * 3

        for pt in points:
            seed = (int(round(pt[0])), int(round(pt[1])))
            if not (0 <= seed[0] < w and 0 <= seed[1] < h):
                continue
            cv2.floodFill(
                im_floodfill, mask, seed, (255, 255, 255),
                lo_diff, up_diff, cv2.FLOODFILL_FIXED_RANGE
            )

        bubble_mask = mask[1:-1, 1:-1] * 255
        contours, _ = cv2.findContours(bubble_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        solid_mask = np.zeros_like(bubble_mask)
        valid_contours = []
        for cnt in contours:
            if cv2.contourArea(cnt) > MIN_CONTOUR_AREA:
                cv2.drawContours(solid_mask, [cnt], -1, 255, cv2.FILLED)
                valid_contours.append(cnt)

        if not valid_contours:
            return {"error": "Контуры не найдены. Попробуй изменить Tolerance."}

        subpaths = _contours_to_subpaths(valid_contours)
        if not subpaths:
            return {"error": "Не удалось построить контур фигуры. Попробуй изменить Tolerance."}

        smoothed = cv2.GaussianBlur(solid_mask, (5, 5), 0)
        _, final_mask = cv2.threshold(smoothed, 127, 255, cv2.THRESH_BINARY)
        final_mask = cv2.bitwise_not(final_mask)

        # Векторизация (lazy import — без vtracer автопоиск всё равно работает)
        import vtracer

        temp_mask_path = os.path.join(
            tempfile.gettempdir(), f"bubblecutter_mask_{os.getpid()}.png"
        )
        cv2.imencode(".png", final_mask)[1].tofile(temp_mask_path)

        vtracer.convert_image_to_svg_py(
            temp_mask_path, output_svg_path,
            colormode='binary', mode='spline',
            corner_threshold=80, filter_speckle=50
        )

        # Конвертируем маску в base64
        _, buffer = cv2.imencode('.png', final_mask)
        mask_base64 = base64.b64encode(buffer).decode('utf-8')

        return {
            "success": True,
            "mask_base64": mask_base64,
            "svg_path": output_svg_path,
            "subpaths": subpaths,
        }

    except Exception as e:
        return {"error": str(e)}


def _boxes_to_points(results, gray):
    """Берёт центры боксов YOLO и ищет рядом светлую точку (фон пузыря)."""
    points = []
    offsets = [
        (0, 0), (0, -10), (10, 0), (-10, 0), (0, 10),
        (10, -10), (-10, -10), (10, 10), (-10, 10),
        (0, -20), (20, 0), (-20, 0), (0, 20),
        (0, -30), (30, 0), (-30, 0), (0, 30),
    ]
    height, width = gray.shape[:2]

    for result in results:
        if result.boxes is None:
            continue
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cx, cy = int((x1 + x2) / 2), int((y1 + y2) / 2)

            best_point = None
            for dx, dy in offsets:
                test_x, test_y = cx + dx, cy + dy
                if 0 <= test_x < width and 0 <= test_y < height and gray[test_y, test_x] > BRIGHT_THRESHOLD:
                    best_point = [test_x, test_y]
                    break

            points.append(best_point or [cx, cy])

    return points


def _is_cuda_oom(error):
    text = str(error).lower()
    return "out of memory" in text and "cuda" in text


def auto_detect(image_path):
    """Находит пузыри с помощью YOLO и ищет точку на фоне внутри пузыря."""
    try:
        from ultralytics import YOLO
        import torch

        model_path = os.path.join(_base_dir(), "bubbles_detect.pt")
        if not os.path.exists(model_path):
            return {"error": "Файл модели bubbles_detect.pt не найден рядом с engine.py!"}

        # Передаём уже декодированный массив — так не ломаются кириллические пути
        img = _read_image(image_path)
        if img is None:
            return {"error": "Не удалось открыть картинку"}
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        model = YOLO(model_path)
        device = 0 if torch.cuda.is_available() else "cpu"

        try:
            results = model.predict(img, conf=0.3, imgsz=640, device=device, verbose=False)
            used_device = "gpu" if device == 0 else "cpu"
        except Exception as e:
            if device == "cpu" or not _is_cuda_oom(e):
                raise
            results = model.predict(img, conf=0.3, imgsz=640, device="cpu", verbose=False)
            used_device = "cpu"

        points = _boxes_to_points(results, gray)
        return {"success": True, "points": points, "device": used_device}

    except Exception as e:
        return {"error": f"Ошибка YOLO: {str(e)}"}


if __name__ == "__main__":
    try:
        input_data = json.loads(sys.argv[1])
        action = input_data.get("action")

        if action == "process":
            result = process_image(
                input_data["image_path"],
                input_data["points"],
                input_data["tolerance"],
                input_data["output_svg_path"]
            )
            print(json.dumps(result, ensure_ascii=False))

        elif action == "detect":
            result = auto_detect(input_data["image_path"])
            print(json.dumps(result, ensure_ascii=False))

        else:
            print(json.dumps({"error": f"Неизвестное действие: {action}"}, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
