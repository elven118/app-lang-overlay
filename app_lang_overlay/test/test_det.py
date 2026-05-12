from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from ..text_det import OnnxTextDetector

def draw_det_boxes(image: Image.Image, results: list[dict]) -> Image.Image:
    img = np.array(image.convert("RGB")).copy()

    for item in results:
        box = item["box"].astype(np.int32)
        score = item["score"]

        cv2.polylines(img, [box], isClosed=True, color=(0, 255, 0), thickness=2)

        x, y = box[0]
        cv2.putText(
            img,
            f"{score:.2f}",
            (int(x), int(y) - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 0, 0),
            1,
            cv2.LINE_AA,
        )

    return Image.fromarray(img)


def main():
    image_path = Path("test.jpg")
    output_path = Path("det_test_result.jpg")

    image = Image.open(image_path).convert("RGB")

    detector = OnnxTextDetector()

    input_tensor, shape_info = detector.pre_process_image(image)

    print("=== preprocess ===")
    print("input tensor shape:", input_tensor.shape)
    print("input dtype:", input_tensor.dtype)
    print("shape info:", shape_info)
    print("min:", input_tensor.min(), "max:", input_tensor.max())

    outputs = detector.session.run(
        [detector.output_name],
        {detector.input_name: input_tensor},
    )

    pred = outputs[0]

    print("\n=== raw ONNX output ===")
    print("output shape:", pred.shape)
    print("output dtype:", pred.dtype)
    print("output min:", pred.min(), "max:", pred.max(), "mean:", pred.mean())

    results = detector.predict(image)

    print("\n=== detection results ===")
    print("num boxes:", len(results))

    for i, item in enumerate(results[:20]):
        print(i, "score:", item["score"], "box:", item["box"].tolist())

    vis = draw_det_boxes(image, results)
    vis.save(output_path)

    print("\nsaved:", output_path.resolve())


if __name__ == "__main__":
    main()