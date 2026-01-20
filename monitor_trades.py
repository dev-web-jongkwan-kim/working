#!/usr/bin/env python3
"""
Trade Strategy Monitor
15분마다 로그를 분석하여 전략별, 서브전략별, 필터별 통과/실패 통계를 기록
오류 발생 시 서버 자동 중단
"""

import re
import time
import subprocess
import os
from datetime import datetime
from collections import defaultdict, Counter

LOG_FILE = '/tmp/backend.log'
REPORT_FILE = '/Users/jongkwankim/my-work/working/TRADE_MONITOR_REPORT.md'
CHECK_INTERVAL = 15 * 60  # 15분

class TradeMonitor:
    def __init__(self):
        self.last_position = 0
        self.iteration = 0

    def stop_server(self):
        """서버 중단"""
        print(f"🚨 [{datetime.now().strftime('%H:%M:%S')}] STOPPING SERVER DUE TO ERROR...")
        subprocess.run(['pkill', '-f', 'node.*dual-strategy'], check=False)
        subprocess.run(['lsof', '-ti:3031'], capture_output=True, text=True, check=False)
        print(f"✅ [{datetime.now().strftime('%H:%M:%S')}] Server stopped")

    def read_new_logs(self):
        """마지막 위치부터 새 로그 읽기"""
        try:
            with open(LOG_FILE, 'r', encoding='utf-8', errors='ignore') as f:
                f.seek(self.last_position)
                new_content = f.read()
                self.last_position = f.tell()
                return new_content
        except Exception as e:
            print(f"❌ Error reading log: {e}")
            return ""

    def check_for_errors(self, content):
        """심각한 오류 체크"""
        error_patterns = [
            r'ECONNREFUSED',
            r'Cannot connect to.*database',
            r'UnhandledPromiseRejectionWarning',
            r'TypeError:',
            r'ReferenceError:',
            r'Fatal error',
            r'SIGTERM',
            r'SIGKILL',
        ]

        for pattern in error_patterns:
            if re.search(pattern, content, re.IGNORECASE):
                return True, pattern
        return False, None

    def analyze_logs(self, content):
        """로그 분석하여 통계 추출"""
        stats = {
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'cycle_rider': self.analyze_cycle_rider(content),
            'hour_swing': self.analyze_hour_swing(content),
            'box_range': self.analyze_box_range(content),
            'orders': self.analyze_orders(content),
            'errors': self.analyze_errors(content),
        }
        return stats

    def analyze_cycle_rider(self, content):
        """Cycle Rider 전략 분석"""
        stats = {
            'total_scans': 0,
            'distribution': {'analyzed': 0, 'detected': 0, 'failed_filters': defaultdict(int)},
            'squeeze': {'analyzed': 0, 'detected': 0, 'failed_filters': defaultdict(int)},
            'signals_generated': 0,
        }

        # Distribution 분석
        dist_analyzed = re.findall(r'\[Distribution\] (\w+) Starting analysis', content)
        dist_detected = re.findall(r'\[Distribution\] (\w+) 🎯 Distribution zone detected', content)
        stats['distribution']['analyzed'] = len(dist_analyzed)
        stats['distribution']['detected'] = len(dist_detected)

        # Distribution 필터 실패
        for pattern, name in [
            (r'Not in distribution \(price not near POC\)', 'Not near POC'),
            (r'Volume spike too strong', 'Volume spike'),
            (r'CVD slope too negative', 'CVD negative'),
            (r'No accumulation pattern', 'No accumulation'),
        ]:
            count = len(re.findall(pattern, content))
            if count > 0:
                stats['distribution']['failed_filters'][name] = count

        # Squeeze Momentum 분석
        squeeze_analyzed = re.findall(r'\[SqueezeMomentum\] (\w+) Starting analysis', content)
        squeeze_detected = re.findall(r'\[SqueezeMomentum\] (\w+) ✅ Squeeze detected', content)
        stats['squeeze']['analyzed'] = len(squeeze_analyzed)
        stats['squeeze']['detected'] = len(squeeze_detected)

        # Squeeze 필터 실패
        for pattern, name in [
            (r'Not in squeeze', 'Not in squeeze'),
            (r'No momentum divergence', 'No divergence'),
            (r'Histogram not bullish', 'Histogram not bullish'),
        ]:
            count = len(re.findall(pattern, content))
            if count > 0:
                stats['squeeze']['failed_filters'][name] = count

        # 시그널 생성
        signals = re.findall(r'\[CycleRider\] (\w+) 🚀 Cycle Rider signal', content)
        stats['signals_generated'] = len(signals)

        return stats

    def analyze_hour_swing(self, content):
        """Hour Swing 전략 분석"""
        stats = {
            'total_scans': 0,
            'mtf_alignment': {'analyzed': 0, 'detected': 0, 'failed_filters': defaultdict(int)},
            'relative_strength': {'analyzed': 0, 'detected': 0, 'failed_filters': defaultdict(int)},
            'funding_extremes': {'analyzed': 0, 'detected': 0, 'extreme_zscore_bypass': 0, 'failed_filters': defaultdict(int)},
            'signals_generated': 0,
        }

        # MTF Alignment 분석
        mtf_analyzed = re.findall(r'\[MTF Alignment\] (\w+) Checking alignment', content)
        mtf_detected = re.findall(r'\[MTF Alignment\] (\w+) ✅.*aligned', content)
        stats['mtf_alignment']['analyzed'] = len(mtf_analyzed)
        stats['mtf_alignment']['detected'] = len(mtf_detected)

        # MTF 필터 실패
        for pattern, name in [
            (r'1H analysis: valid=false', '1H trend invalid'),
            (r'15M analysis: aligned=false', '15M not aligned'),
            (r'strength=0\.00', 'Trend too weak'),
        ]:
            count = len(re.findall(pattern, content))
            if count > 0:
                stats['mtf_alignment']['failed_filters'][name] = count

        # Relative Strength 분석
        rs_analyzed = re.findall(r'\[RelativeStrength\] (\w+) Checking relative strength', content)
        rs_detected = re.findall(r'\[RelativeStrength\] (\w+) ✅ Relative strength confirmed', content)
        stats['relative_strength']['analyzed'] = len(rs_analyzed)
        stats['relative_strength']['detected'] = len(rs_detected)

        # RS 필터 실패
        for pattern, name in [
            (r'BTC bearish cross detected', 'BTC bearish'),
            (r'BTC bullish cross detected', 'BTC bullish'),
            (r'Altcoin weaker than BTC', 'Weaker than BTC'),
        ]:
            count = len(re.findall(pattern, content))
            if count > 0:
                stats['relative_strength']['failed_filters'][name] = count

        # Funding Extremes 분석
        fe_analyzed = re.findall(r'\[FundingExtremes\] (\w+) Starting analysis', content)
        fe_detected = re.findall(r'\[FundingExtremes\] (\w+) 💥 Extreme funding detected', content)
        fe_extreme_bypass = re.findall(r'\[FundingExtremes\] (\w+) 🔥 EXTREME zScore detected', content)
        stats['funding_extremes']['analyzed'] = len(fe_analyzed)
        stats['funding_extremes']['detected'] = len(fe_detected)
        stats['funding_extremes']['extreme_zscore_bypass'] = len(fe_extreme_bypass)

        # FE 필터 실패
        for pattern, name in [
            (r'Market structure break: broken=false', 'Structure not broken'),
            (r'Momentum slowing: false', 'Momentum not slowing'),
            (r'isExtreme=false', 'Funding not extreme'),
        ]:
            count = len(re.findall(pattern, content))
            if count > 0:
                stats['funding_extremes']['failed_filters'][name] = count

        # 시그널 생성
        signals = re.findall(r'\[HourSwing\] (\w+) 🎯.*signal generated', content)
        stats['signals_generated'] = len(signals)

        return stats

    def analyze_box_range(self, content):
        """Box Range 전략 분석"""
        stats = {
            'total_scans': 0,
            'boxes_detected': 0,
            'box_grades': Counter(),
            'entry_analysis': {'analyzed': 0, 'generated': 0},
            'failed_filters': defaultdict(int),
            'signals_generated': 0,
        }

        # Box 감지
        boxes = re.findall(r'\[BoxDetector\] (\w+) ✅ Box detected! Grade=([ABC])', content)
        stats['boxes_detected'] = len(boxes)
        for symbol, grade in boxes:
            stats['box_grades'][grade] += 1

        # Entry 분석
        entry_analyzed = re.findall(r'\[BoxRangeSignal\] (\w+) Starting box range analysis', content)
        entry_generated = re.findall(r'\[BoxRangeSignal\] (\w+) 🎯 Box Range signal generated', content)
        stats['entry_analysis']['analyzed'] = len(entry_analyzed)
        stats['entry_analysis']['generated'] = len(entry_generated)

        # 필터 실패
        for pattern, name in [
            (r'Failed ATR filter', 'ATR out of range'),
            (r'1H ADX too high', 'ADX too high'),
            (r'Failed upper timeframe filter', 'Upper TF failed'),
            (r'Box invalidated by price breakout', 'Box breakout'),
            (r'Symbol disabled', 'Symbol disabled'),
        ]:
            count = len(re.findall(pattern, content))
            if count > 0:
                stats['failed_filters'][name] = count

        # 시그널 생성
        signals = re.findall(r'\[BoxRangeSignal\] (\w+) 🎯 Box Range signal generated', content)
        stats['signals_generated'] = len(signals)

        return stats

    def analyze_orders(self, content):
        """주문 분석"""
        stats = {
            'orders_placed': 0,
            'orders_filled': 0,
            'orders_cancelled': 0,
            'positions_opened': 0,
            'positions_closed': 0,
        }

        orders_placed = re.findall(r'Order placed.*(\w+USDT)', content)
        orders_filled = re.findall(r'Order filled.*(\w+USDT)', content)
        orders_cancelled = re.findall(r'Order cancelled.*(\w+USDT)', content)
        positions_opened = re.findall(r'Position opened.*(\w+USDT)', content)
        positions_closed = re.findall(r'Position closed.*(\w+USDT)', content)

        stats['orders_placed'] = len(orders_placed)
        stats['orders_filled'] = len(orders_filled)
        stats['orders_cancelled'] = len(orders_cancelled)
        stats['positions_opened'] = len(positions_opened)
        stats['positions_closed'] = len(positions_closed)

        return stats

    def analyze_errors(self, content):
        """오류 분석"""
        errors = []

        error_lines = re.findall(r'\[31merror\[39m.*', content)
        warn_lines = re.findall(r'\[33mwarn\[39m.*', content)

        return {
            'error_count': len(error_lines),
            'warning_count': len(warn_lines),
            'errors': error_lines[:10] if error_lines else [],  # 최대 10개만
            'warnings': warn_lines[:10] if warn_lines else [],
        }

    def write_report(self, stats):
        """리포트 파일에 통계 기록"""
        try:
            # 파일 존재 여부 확인
            if self.iteration == 0 or not os.path.exists(REPORT_FILE):
                # 첫 실행이거나 파일이 없으면 헤더 작성
                with open(REPORT_FILE, 'w') as f:
                    f.write(f"# Trading Strategy Monitor Report\n\n")
                    f.write(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
                    f.write("---\n\n")

            # 통계 추가
            with open(REPORT_FILE, 'a') as f:
                f.write(f"## Scan #{self.iteration + 1} - {stats['timestamp']}\n\n")

                # Cycle Rider
                f.write("### 🔄 Cycle Rider Strategy\n\n")
                cr = stats['cycle_rider']
                f.write(f"- **Distribution**: {cr['distribution']['detected']}/{cr['distribution']['analyzed']} detected\n")
                if cr['distribution']['failed_filters']:
                    f.write("  - Failed filters:\n")
                    for name, count in cr['distribution']['failed_filters'].items():
                        f.write(f"    - {name}: {count}\n")
                f.write(f"- **Squeeze Momentum**: {cr['squeeze']['detected']}/{cr['squeeze']['analyzed']} detected\n")
                if cr['squeeze']['failed_filters']:
                    f.write("  - Failed filters:\n")
                    for name, count in cr['squeeze']['failed_filters'].items():
                        f.write(f"    - {name}: {count}\n")
                f.write(f"- **Signals Generated**: {cr['signals_generated']}\n\n")

                # Hour Swing
                f.write("### ⏰ Hour Swing Strategy\n\n")
                hs = stats['hour_swing']
                f.write(f"- **MTF Alignment**: {hs['mtf_alignment']['detected']}/{hs['mtf_alignment']['analyzed']} aligned\n")
                if hs['mtf_alignment']['failed_filters']:
                    f.write("  - Failed filters:\n")
                    for name, count in hs['mtf_alignment']['failed_filters'].items():
                        f.write(f"    - {name}: {count}\n")
                f.write(f"- **Relative Strength**: {hs['relative_strength']['detected']}/{hs['relative_strength']['analyzed']} confirmed\n")
                if hs['relative_strength']['failed_filters']:
                    f.write("  - Failed filters:\n")
                    for name, count in hs['relative_strength']['failed_filters'].items():
                        f.write(f"    - {name}: {count}\n")
                f.write(f"- **Funding Extremes**: {hs['funding_extremes']['detected']}/{hs['funding_extremes']['analyzed']} extreme detected\n")
                f.write(f"  - 🔥 Extreme zScore bypass: {hs['funding_extremes']['extreme_zscore_bypass']}\n")
                if hs['funding_extremes']['failed_filters']:
                    f.write("  - Failed filters:\n")
                    for name, count in hs['funding_extremes']['failed_filters'].items():
                        f.write(f"    - {name}: {count}\n")
                f.write(f"- **Signals Generated**: {hs['signals_generated']}\n\n")

                # Box Range
                f.write("### 📦 Box Range Strategy\n\n")
                br = stats['box_range']
                f.write(f"- **Boxes Detected**: {br['boxes_detected']}\n")
                if br['box_grades']:
                    f.write("  - Grades:\n")
                    for grade, count in sorted(br['box_grades'].items()):
                        f.write(f"    - Grade {grade}: {count}\n")
                f.write(f"- **Entry Analysis**: {br['entry_analysis']['generated']}/{br['entry_analysis']['analyzed']} signals\n")
                if br['failed_filters']:
                    f.write("  - Failed filters:\n")
                    for name, count in br['failed_filters'].items():
                        f.write(f"    - {name}: {count}\n")
                f.write(f"- **Signals Generated**: {br['signals_generated']}\n\n")

                # Orders
                f.write("### 📊 Trading Activity\n\n")
                orders = stats['orders']
                f.write(f"- Orders Placed: {orders['orders_placed']}\n")
                f.write(f"- Orders Filled: {orders['orders_filled']}\n")
                f.write(f"- Positions Opened: {orders['positions_opened']}\n")
                f.write(f"- Positions Closed: {orders['positions_closed']}\n\n")

                # Errors
                errs = stats['errors']
                if errs['error_count'] > 0 or errs['warning_count'] > 0:
                    f.write("### ⚠️ Errors & Warnings\n\n")
                    f.write(f"- Errors: {errs['error_count']}\n")
                    f.write(f"- Warnings: {errs['warning_count']}\n")
                    if errs['errors']:
                        f.write("\nRecent errors:\n")
                        for err in errs['errors'][:5]:
                            f.write(f"```\n{err}\n```\n")
                    f.write("\n")

                f.write("---\n\n")

            print(f"✅ [{datetime.now().strftime('%H:%M:%S')}] Report updated: Scan #{self.iteration + 1}")

        except Exception as e:
            print(f"❌ Error writing report: {e}")

    def run(self):
        """메인 모니터링 루프"""
        print(f"🚀 Trade Monitor started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"📝 Report file: {REPORT_FILE}")
        print(f"⏱️  Check interval: {CHECK_INTERVAL // 60} minutes")
        print(f"🔍 Monitoring for errors and generating statistics...\n")

        while True:
            try:
                # 새 로그 읽기
                content = self.read_new_logs()

                if content:
                    # 오류 체크
                    has_error, error_pattern = self.check_for_errors(content)
                    if has_error:
                        print(f"\n❌ CRITICAL ERROR DETECTED: {error_pattern}")
                        self.stop_server()
                        print(f"💾 Final report saved to: {REPORT_FILE}")
                        break

                    # 통계 분석
                    stats = self.analyze_logs(content)

                    # 리포트 작성
                    self.write_report(stats)

                    self.iteration += 1

                # 다음 체크까지 대기
                time.sleep(CHECK_INTERVAL)

            except KeyboardInterrupt:
                print(f"\n\n🛑 Monitor stopped by user")
                print(f"💾 Report saved to: {REPORT_FILE}")
                break
            except Exception as e:
                print(f"\n❌ Unexpected error: {e}")
                self.stop_server()
                break

if __name__ == '__main__':
    monitor = TradeMonitor()
    monitor.run()
