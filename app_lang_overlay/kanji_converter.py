import pykakasi

class KanjiConverter:
    def __init__(self) -> None:
        self.kks = pykakasi.kakasi()

    def kanji_to_hiragana(self, text: str) -> str:
        lines = text.split('\n')
        processed_lines = []

        for line in lines:
            result = self.kks.convert(line)
            html_text = ''
            for item in result:
                orig = item["orig"]
                hira = item["hira"]
                kana = item["kana"]
                if orig != hira and orig != kana:
                    html_text += f'<ruby><rb>{orig}</rb><rt>{hira}</rt></ruby>'
                else:
                    html_text += orig
            processed_lines.append(html_text)
            
        return '\n'.join(processed_lines)