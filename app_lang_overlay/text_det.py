from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import pyclipper

import onnxruntime as ort

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_ROOT = PROJECT_ROOT / "models"

DET_MODEL_PATH = MODELS_ROOT / "det_onnx" / "PP-OCRv5_server_det.onnx"

DET_THRESH = 0.3
DET_BOX_THRESH = 0.6
DET_MAX_CANDIDATES = 1000
DET_MIN_BOX_SIDE = 3
DET_UNCLIP_RATIO = 1.4
DET_RESIZE_LONG = 960
DET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
DET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

class OnnxTextDetector:
    def __init__(self) -> None:
        print(f"[overlay-backend] init ONNX text detector model={DET_MODEL_PATH}")
        self.session = ort.InferenceSession(str(DET_MODEL_PATH))
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
    
    def pre_process_image(self, image: Image.Image) -> tuple[np.ndarray, dict[str, any]]:
        """
        PaddleOCR-style detection preprocessing.

        Output:
            input_tensor: float32, shape=(1, 3, H, W)
            shape_info:
                original_height
                original_width
                resized_height
                resized_width
                ratio_h
                ratio_w
        """
        img = np.array(image)
        original_height, original_width = img.shape[:2]
        # Resize image
        resized_img, ratio_h, ratio_w = self._resize_det_img(img)
        # NormalizeImage:
        resized_img = resized_img.astype("float32") / 255.0
        resized_img = (resized_img - DET_MEAN) / DET_STD
        # ToCHWImage
        resized_img = resized_img.transpose(2, 0, 1)
        # Add batch dimension
        input_tensor = np.expand_dims(resized_img, axis=0).astype(np.float32)
        shape_info = {
            "original_height": original_height,
            "original_width": original_width,
            "resized_height": input_tensor.shape[2],
            "resized_width": input_tensor.shape[3],
            "ratio_h": ratio_h,
            "ratio_w": ratio_w,
        }
        return input_tensor, shape_info

    def _resize_det_img(self, img: np.ndarray) -> tuple[np.ndarray, float, float]:
        height, width = img.shape[:2]
        ratio = 1.0
        side = max(height, width)

        if side > DET_RESIZE_LONG:
            ratio = float(DET_RESIZE_LONG) / side
        resize_height = int(height * ratio)
        resize_width = int(width * ratio)
        # Make dimensions multiples of 32
        resize_height = max(32, int(round(resize_height / 32) * 32))
        resize_width = max(32, int(round(resize_width / 32) * 32))
        resized_img = cv2.resize(img, (resize_width, resize_height))
        ratio_h = resize_height / float(height)
        ratio_w = resize_width / float(width)
        return resized_img, ratio_h, ratio_w

    def _sort_boxes(self, results: list[dict[str, any]]) -> list[dict[str, any]]:
        """
        Sort boxes top-to-bottom, left-to-right.
        Similar behavior to PaddleOCR utility sorting.
        """
        results = sorted(
            results,
            key=lambda r: (
                np.min(r["box"][:, 1]),
                np.min(r["box"][:, 0]),
            ),
        )
        # Fine adjustment: if two boxes are on almost the same row,
        # sort by x.
        for i in range(len(results) - 1):
            for j in range(i, 0, -1):
                box_j = results[j]["box"]
                box_prev = results[j - 1]["box"]

                y_j = np.min(box_j[:, 1])
                y_prev = np.min(box_prev[:, 1])
                x_j = np.min(box_j[:, 0])
                x_prev = np.min(box_prev[:, 0])

                if abs(y_j - y_prev) < 20 and x_j < x_prev:
                    results[j], results[j - 1] = results[j - 1], results[j]
                else:
                    break

        return results

    def predict(self, image: Image.Image) -> list[dict[str, any]]:
        input_tensor, shape_info = self.pre_process_image(image)
        outputs = self.session.run(
            [self.output_name],
            {self.input_name: input_tensor},
        )
        pred = outputs[0]
        boxes, scores = self.post_predict(pred, shape_info)
        results = [
            {
                "box": box.astype(np.int16),
                "score": float(score),
            }
            for box, score in zip(boxes, scores)
        ]
        results = self._sort_boxes(results)
        return results

    def post_predict(
        self,
        pred: np.ndarray,
        shape_info: dict[str, any],
    ) -> tuple[list[np.ndarray], list[float]]:
        """
        DB postprocess.
        Common ONNX output shape:
            (1, 1, H, W)
        """
        if pred.ndim != 4:
            raise ValueError(f"Unexpected detector output shape: {pred.shape}")
        pred = pred[0, 0]
        pred = pred.astype(np.float32)
        bitmap = pred > DET_THRESH
        boxes, scores = self._boxes_from_bitmap(
            pred=pred,
            bitmap=bitmap,
            dest_width=shape_info["original_width"],
            dest_height=shape_info["original_height"],
        )
        return boxes, scores

    def _boxes_from_bitmap(
        self,
        pred: np.ndarray,
        bitmap: np.ndarray,
        dest_width: int,
        dest_height: int,
    ) -> tuple[list[np.ndarray], list[float]]:
        bitmap_uint8 = (bitmap.astype(np.uint8) * 255)
        contours, _ = cv2.findContours(
            bitmap_uint8,
            cv2.RETR_LIST,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        num_contours = min(len(contours), DET_MAX_CANDIDATES)

        boxes: list[np.ndarray] = []
        scores: list[float] = []

        height, width = bitmap.shape

        for index in range(num_contours):
            contour = contours[index]

            points, short_side = self._get_mini_boxes(contour)

            if short_side < DET_MIN_BOX_SIDE:
                continue

            score = self._box_score_fast(pred, points.reshape(-1, 2))

            if score < DET_BOX_THRESH:
                continue

            unclipped = self._unclip(points, DET_UNCLIP_RATIO)

            if len(unclipped) == 0:
                continue

            box, short_side = self._get_mini_boxes(unclipped)

            if short_side < DET_MIN_BOX_SIDE + 2:
                continue

            box = np.array(box)

            # Scale from resized feature map size back to original image size.
            box[:, 0] = np.clip(
                np.round(box[:, 0] / width * dest_width),
                0,
                dest_width,
            )
            box[:, 1] = np.clip(
                np.round(box[:, 1] / height * dest_height),
                0,
                dest_height,
            )

            boxes.append(box.astype(np.int32))
            scores.append(float(score))

        return boxes, scores

    def _get_mini_boxes(self, contour: np.ndarray) -> tuple[np.ndarray, float]:
        bounding_box = cv2.minAreaRect(contour)
        points = cv2.boxPoints(bounding_box)

        # Sort by x coordinate first.
        points = sorted(list(points), key=lambda x: x[0])

        left_points = points[:2]
        right_points = points[2:]

        left_points = sorted(left_points, key=lambda x: x[1])
        right_points = sorted(right_points, key=lambda x: x[1])

        box = np.array(
            [
                left_points[0],
                right_points[0],
                right_points[1],
                left_points[1],
            ],
            dtype=np.float32,
        )

        side_1 = np.linalg.norm(box[0] - box[1])
        side_2 = np.linalg.norm(box[1] - box[2])

        short_side = min(side_1, side_2)

        return box, short_side

    def _box_score_fast(self, bitmap: np.ndarray, box: np.ndarray) -> float:
        h, w = bitmap.shape[:2]

        box = box.copy()

        xmin = np.clip(np.floor(box[:, 0].min()).astype("int32"), 0, w - 1)
        xmax = np.clip(np.ceil(box[:, 0].max()).astype("int32"), 0, w - 1)
        ymin = np.clip(np.floor(box[:, 1].min()).astype("int32"), 0, h - 1)
        ymax = np.clip(np.ceil(box[:, 1].max()).astype("int32"), 0, h - 1)

        mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), dtype=np.uint8)

        shifted_box = box.copy()
        shifted_box[:, 0] = shifted_box[:, 0] - xmin
        shifted_box[:, 1] = shifted_box[:, 1] - ymin

        cv2.fillPoly(mask, shifted_box.reshape(1, -1, 2).astype("int32"), 1)

        return cv2.mean(bitmap[ymin : ymax + 1, xmin : xmax + 1], mask)[0]

    def _unclip(self, box: np.ndarray, unclip_ratio: float) -> np.ndarray:
        box = box.astype(np.float32)
        area = cv2.contourArea(box)
        perimeter = cv2.arcLength(box.reshape(-1, 1, 2), True)

        if area <= 0 or perimeter <= 0:
            return np.array([])

        distance = area * unclip_ratio / perimeter

        offset = pyclipper.PyclipperOffset()
        offset.AddPath(box.tolist(), pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)

        expanded = offset.Execute(distance)

        if len(expanded) == 0:
            return np.array([])

        expanded = np.array(expanded[0], dtype=np.float32)

        return expanded
