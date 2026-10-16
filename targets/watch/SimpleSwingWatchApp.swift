import HealthKit
import SwiftUI
import WatchKit

/**
 SimpleSwing on Apple Watch: a one-tap SAVE remote for the phone's camera and, in auto mode, a
 wrist swing sensor (impact timing + tempo) that keeps running with the screen off during a golf
 workout. Watch side of WatchBridge.swift; the Wear OS twin is wear/.
 */
@main
struct SimpleSwingWatchApp: App {
  @WKApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      ContentView(model: .shared)
    }
  }
}

final class AppDelegate: NSObject, WKApplicationDelegate {
  func applicationDidFinishLaunching() {
    WatchModel.shared.launch()
  }

  /// Relaunched after a crash mid-workout: the session is still running and must be picked up.
  func handleActiveWorkoutRecovery() {
    WatchModel.shared.launch()
    WatchModel.shared.recoverWorkout()
  }

  /// Launched by the phone with HKHealthStore.startWatchApp (not used by the phone yet).
  func handle(_ workoutConfiguration: HKWorkoutConfiguration) {
    WatchModel.shared.launch()
    WatchModel.shared.startedByPhone()
  }

  func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
    for task in backgroundTasks {
      if let task = task as? WKWatchConnectivityRefreshBackgroundTask {
        // Woken to receive an application context: keep the task until it's been delivered.
        WatchModel.shared.launch()
        WatchModel.shared.link.whenIdle { task.setTaskCompletedWithSnapshot(false) }
      } else {
        task.setTaskCompletedWithSnapshot(false)
      }
    }
  }
}
