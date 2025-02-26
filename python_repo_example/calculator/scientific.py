from .basic_ops import Calculator
from utils.logger import log_result

class ScientificCalculator(Calculator):
    def square_root(self, x):
        if x < 0:
            log_result("Error", "Cannot calculate square root of negative number")
            raise ValueError("Cannot calculate square root of negative number")
        return x ** 0.5
    
    def power(self, base, exponent):
        return base ** exponent 