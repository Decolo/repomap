from calculator.basic_ops import Calculator
from calculator.scientific import ScientificCalculator
from utils.logger import log_result

def main():
    # 基础计算器测试
    calc = Calculator()
    result = calc.add(5, 3)
    log_result("Basic addition", result)

    # 科学计算器测试
    sci_calc = ScientificCalculator()
    result = sci_calc.square_root(16)
    log_result("Square root", result)

if __name__ == "__main__":
    main() 