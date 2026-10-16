import SwiftUI

/// The SAVE screen, as on Wear OS (MainActivity's SaveSwingScreen): tap after your swing and the
/// phone keeps the last few seconds.
struct ContentView: View {
  private static let green = Color(red: 0x3D / 255, green: 0xCB / 255, blue: 0x7A / 255)

  @ObservedObject var model: WatchModel
  @Environment(\.scenePhase) private var scenePhase
  /// Always On with the wrist down: no fills, just enough to show the app is still here.
  @Environment(\.isLuminanceReduced) private var dimmed

  var body: some View {
    VStack(spacing: 8) {
      if dimmed {
        Text("SimpleSwing").font(.system(size: 14)).foregroundStyle(.gray)
        Text("Tap to wake").font(.system(size: 12)).foregroundStyle(.gray)
      } else {
        Button(action: model.saveSwing) {
          Text("SAVE")
            .font(.system(size: 20, weight: .bold))
            .foregroundStyle(.black)
            .frame(width: 96, height: 96)
            .background(Circle().fill(Self.green))
        }
        .buttonStyle(.plain)
        .disabled(!model.status.canTrigger)
        .opacity(model.status.canTrigger ? 1 : 0.4)
        .accessibilityLabel("Save swing")

        Text(model.status.label)
          .font(.system(size: 14))
          .multilineTextAlignment(.center)
        if model.sensing {
          Text(sensingLabel)
            .font(.system(size: 12))
            .multilineTextAlignment(.center)
            .foregroundStyle(Self.green)
          if !model.screenOffSensing {
            Text("Allow Health access in Settings to sense with the screen off")
              .font(.system(size: 11))
              .multilineTextAlignment(.center)
              .foregroundStyle(.gray)
          }
        }
      }
    }
    .minimumScaleFactor(0.8)
    .padding(.horizontal, 4)
    .onChange(of: scenePhase, initial: true) { _, phase in
      if phase == .active { model.becameActive() }
    }
  }

  private var sensingLabel: String {
    guard let dps = model.lastSwingDps else { return "Watching for swings" }
    let tempo = model.lastTempo.map { " · \($0)" } ?? ""
    return "Watching swings · last \(dps)°/s\(tempo)"
  }
}
