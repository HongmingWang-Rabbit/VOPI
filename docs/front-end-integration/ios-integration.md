# iOS/Swift Integration Guide

Complete guide for integrating VOPI into iOS applications using Swift and URLSession.

> **Important: Private S3 Bucket**
>
> The VOPI S3 bucket is private. Direct URLs in job results are not publicly accessible. You must use the `/jobs/:id/download-urls` endpoint to get presigned URLs with temporary access tokens. These URLs expire after a configurable time (default: 1 hour).

## Table of Contents

- [Setup](#setup)
- [API Client](#api-client)
- [Models](#models)
- [Video Upload](#video-upload)
- [Job Management](#job-management)
- [Complete Example](#complete-example)

## Setup

### Requirements

- iOS 15.0+
- Swift 5.5+
- Xcode 14+

### Configuration

Create a configuration file for API settings:

```swift
// VOPIConfig.swift
import Foundation

enum VOPIConfig {
    static let baseURL = URL(string: "https://api.your-domain.com")!
    static let apiKey = "your-api-key"

    // Timeouts
    static let uploadTimeout: TimeInterval = 300 // 5 minutes
    static let requestTimeout: TimeInterval = 30
    static let pollingInterval: TimeInterval = 3
}
```

## API Client

### Base API Client

```swift
// VOPIClient.swift
import Foundation

enum VOPIError: Error {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, message: String)
    case decodingError(Error)
    case uploadFailed(Error)
    case networkError(Error)
}

class VOPIClient {
    static let shared = VOPIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = VOPIConfig.requestTimeout
        self.session = URLSession(configuration: config)

        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601

        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .iso8601
    }

    // MARK: - Request Building

    private func makeRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil
    ) -> URLRequest {
        var request = URLRequest(url: VOPIConfig.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue(VOPIConfig.apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    // MARK: - Generic Request

    func request<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Encodable? = nil
    ) async throws -> T {
        var bodyData: Data? = nil
        if let body = body {
            bodyData = try encoder.encode(body)
        }

        let request = makeRequest(path: path, method: method, body: bodyData)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VOPIError.invalidResponse
        }

        if httpResponse.statusCode >= 400 {
            let errorResponse = try? decoder.decode(APIError.self, from: data)
            throw VOPIError.httpError(
                statusCode: httpResponse.statusCode,
                message: errorResponse?.error ?? "Unknown error"
            )
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw VOPIError.decodingError(error)
        }
    }

    // MARK: - Presigned URL

    func getPresignedURL(
        filename: String,
        contentType: String = "video/mp4",
        expiresIn: Int = 3600
    ) async throws -> PresignResponse {
        let body = PresignRequest(
            filename: filename,
            contentType: contentType,
            expiresIn: expiresIn
        )

        return try await request(
            path: "/api/v1/uploads/presign",
            method: "POST",
            body: body
        )
    }

    // MARK: - Upload to S3

    func uploadToS3(
        url: URL,
        fileURL: URL,
        contentType: String,
        progressHandler: ((Double) -> Void)? = nil
    ) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")

        // Get file size for progress
        let fileSize = try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? Int64 ?? 0

        // Create upload task with progress
        let delegate = UploadProgressDelegate(totalSize: fileSize, progressHandler: progressHandler)
        let uploadSession = URLSession(
            configuration: .default,
            delegate: delegate,
            delegateQueue: nil
        )

        let (_, response) = try await uploadSession.upload(for: request, fromFile: fileURL)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw VOPIError.uploadFailed(NSError(domain: "S3Upload", code: -1))
        }
    }

    // MARK: - Jobs

    func createJob(
        videoUrl: String,
        config: JobConfig? = nil,
        callbackUrl: String? = nil
    ) async throws -> Job {
        let body = CreateJobRequest(
            videoUrl: videoUrl,
            config: config,
            callbackUrl: callbackUrl
        )

        return try await request(
            path: "/api/v1/jobs",
            method: "POST",
            body: body
        )
    }

    func getJob(id: String) async throws -> Job {
        return try await request(path: "/api/v1/jobs/\(id)")
    }

    func getJobStatus(id: String) async throws -> JobStatus {
        return try await request(path: "/api/v1/jobs/\(id)/status")
    }

    func cancelJob(id: String) async throws -> CancelJobResponse {
        return try await request(
            path: "/api/v1/jobs/\(id)/cancel",
            method: "POST"
        )
    }

    func deleteJob(id: String) async throws {
        let _: EmptyResponse = try await request(
            path: "/api/v1/jobs/\(id)",
            method: "DELETE"
        )
    }

    func deleteJobImage(jobId: String, frameId: String, version: String) async throws -> DeleteJobImageResponse {
        return try await request(
            path: "/api/v1/jobs/\(jobId)/images/\(frameId)/\(version)",
            method: "DELETE"
        )
    }

    func getGroupedImages(jobId: String) async throws -> [String: [String: String]] {
        return try await request(path: "/api/v1/jobs/\(jobId)/images/grouped")
    }

    func getFinalFrames(jobId: String) async throws -> [Frame] {
        return try await request(path: "/api/v1/jobs/\(jobId)/frames/final")
    }

    /// Get presigned download URLs for job assets (required for private S3 bucket)
    /// - Parameters:
    ///   - jobId: The job ID
    ///   - expiresIn: URL expiration in seconds (60-86400, default: 3600)
    /// - Returns: Presigned URLs for frames and commercial images
    func getDownloadUrls(jobId: String, expiresIn: Int = 3600) async throws -> DownloadUrlsResponse {
        return try await request(path: "/api/v1/jobs/\(jobId)/download-urls?expiresIn=\(expiresIn)")
    }
}

// MARK: - Upload Progress Delegate

class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    private let totalSize: Int64
    private let progressHandler: ((Double) -> Void)?

    init(totalSize: Int64, progressHandler: ((Double) -> Void)?) {
        self.totalSize = totalSize
        self.progressHandler = progressHandler
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        let progress = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        DispatchQueue.main.async {
            self.progressHandler?(progress)
        }
    }
}
```

## Models

### API Models

```swift
// VOPIModels.swift
import Foundation

// MARK: - API Error

struct APIError: Decodable {
    let error: String
    let statusCode: Int
    let details: [String: String]?
}

// MARK: - Presign

struct PresignRequest: Encodable {
    let filename: String?
    let contentType: String
    let expiresIn: Int?
}

struct PresignResponse: Decodable {
    let uploadUrl: String
    let key: String
    let publicUrl: String
    let expiresIn: Int
}

// MARK: - Job

struct JobConfig: Codable {
    var fps: Int = 10
    var batchSize: Int = 30
    var commercialVersions: [CommercialVersion] = CommercialVersion.allCases
    var aiCleanup: Bool = true
    var geminiModel: String = "gemini-2.0-flash"
}

enum CommercialVersion: String, Codable, CaseIterable {
    case transparent
    case solid
    case real
    case creative
}

struct CreateJobRequest: Encodable {
    let videoUrl: String
    let config: JobConfig?
    let callbackUrl: String?
}

struct Job: Decodable {
    let id: String
    let status: JobStatusType
    let videoUrl: String
    let config: JobConfig?
    let progress: JobProgress?
    let result: JobResult?
    let error: String?
    let createdAt: Date
    let updatedAt: Date?
    let startedAt: Date?
    let completedAt: Date?
}

enum JobStatusType: String, Decodable {
    case pending
    case downloading
    case extracting
    case scoring
    case classifying
    case extractingProduct = "extracting_product"
    case generating
    case completed
    case failed
    case cancelled
}

struct JobProgress: Decodable {
    let step: String
    let percentage: Int
    let message: String?
    let totalSteps: Int?
    let currentStep: Int?
}

struct JobStatus: Decodable {
    let id: String
    let status: JobStatusType
    let progress: JobProgress?
    let createdAt: Date
    let updatedAt: Date?
}

struct JobResult: Decodable {
    let variantsDiscovered: Int?
    let framesAnalyzed: Int?
    let finalFrames: [String]?
    let commercialImages: [String: [String: String]]?
}

struct CancelJobResponse: Decodable {
    let id: String
    let status: JobStatusType
    let message: String
}

struct EmptyResponse: Decodable {}

struct DeleteJobImageResponse: Decodable {
    let commercialImages: [String: [String: String]]
}

// MARK: - Download URLs (for private S3 bucket)

struct DownloadUrlsResponse: Decodable {
    let jobId: String
    let expiresIn: Int
    let frames: [FrameDownload]
    let commercialImages: [String: [String: String]]
    /// Product metadata extracted from audio analysis (null if no audio or analysis failed)
    let productMetadata: ProductMetadataOutput?
}

struct FrameDownload: Decodable {
    let frameId: String
    let downloadUrl: String
}

// MARK: - Product Metadata (from audio analysis)

/// Complete product metadata output including platform-specific formats
struct ProductMetadataOutput: Decodable {
    /// Raw transcript from audio
    let transcript: String
    /// Universal product metadata
    let product: ProductMetadata
    /// Platform-specific formatted versions
    let platforms: PlatformFormats
    /// ISO timestamp when metadata was extracted
    let extractedAt: String
    /// Audio duration in seconds (if available)
    let audioDuration: Double?
    /// Pipeline version
    let pipelineVersion: String
}

/// Universal product metadata
struct ProductMetadata: Decodable {
    let title: String
    let description: String
    let shortDescription: String?
    let bulletPoints: [String]
    let brand: String?
    let category: String?
    let subcategory: String?
    let materials: [String]?
    let color: String?
    let colors: [String]?
    let size: String?
    let sizes: [String]?
    let price: Double?
    let currency: String?
    let keywords: [String]?
    let tags: [String]?
    let condition: String?
    let confidence: MetadataConfidence
    let extractedFromAudio: Bool
    let transcriptExcerpts: [String]?
}

/// Confidence scores for metadata fields
struct MetadataConfidence: Decodable {
    let overall: Int
    let title: Int
    let description: Int
    let price: Int?
    let attributes: Int?
}

/// Platform-specific formatted product data
struct PlatformFormats: Decodable {
    let shopify: ShopifyProduct
    let amazon: AmazonProduct
    let ebay: EbayProduct
}

/// Shopify-formatted product data
struct ShopifyProduct: Decodable {
    let title: String
    let descriptionHtml: String
    let productType: String?
    let vendor: String?
    let tags: [String]?
    let status: String?
}

/// Amazon-formatted product data
struct AmazonProduct: Decodable {
    let item_name: String
    let brand_name: String?
    let product_description: String?
    let bullet_point: [String]?
    let generic_keyword: [String]?
    let color: String?
    let material: [String]?
}

/// eBay-formatted product data
struct EbayProduct: Decodable {
    let title: String
    let description: String
    let condition: String
    let conditionDescription: String?
    let brand: String?
    let aspects: [String: [String]]?
}

// MARK: - Frame

struct Frame: Decodable {
    let id: String
    let jobId: String
    let frameId: String
    let timestamp: Double
    let s3Url: String
    let productId: String?
    let variantId: String?
    let angleEstimate: String?
    let variantDescription: String?
    let obstructions: FrameObstructions?
    let backgroundRecommendations: BackgroundRecommendations?
    let createdAt: Date
}

struct FrameObstructions: Decodable {
    let hasObstruction: Bool
    let obstructionTypes: [String]?
    let obstructionDescription: String?
    let removableByAi: Bool?

    enum CodingKeys: String, CodingKey {
        case hasObstruction = "has_obstruction"
        case obstructionTypes = "obstruction_types"
        case obstructionDescription = "obstruction_description"
        case removableByAi = "removable_by_ai"
    }
}

struct BackgroundRecommendations: Decodable {
    let solidColor: String?
    let solidColorName: String?
    let realLifeSetting: String?
    let creativeShot: String?

    enum CodingKeys: String, CodingKey {
        case solidColor = "solid_color"
        case solidColorName = "solid_color_name"
        case realLifeSetting = "real_life_setting"
        case creativeShot = "creative_shot"
    }
}
```

## Video Upload

### Video Picker and Upload Manager

```swift
// VideoUploadManager.swift
import Foundation
import PhotosUI
import SwiftUI

@MainActor
class VideoUploadManager: ObservableObject {
    @Published var uploadProgress: Double = 0
    @Published var processingProgress: Int = 0
    @Published var currentStep: String = ""
    @Published var isUploading = false
    @Published var isProcessing = false
    @Published var error: Error?
    @Published var completedJob: Job?
    @Published var groupedImages: [String: [String: String]] = [:]

    private var currentJobId: String?
    private var pollingTask: Task<Void, Never>?

    // MARK: - Full Upload Flow

    func uploadAndProcess(
        videoURL: URL,
        config: JobConfig = JobConfig()
    ) async {
        isUploading = true
        isProcessing = false
        uploadProgress = 0
        error = nil

        do {
            // Step 1: Get presigned URL
            currentStep = "Preparing upload..."
            let filename = videoURL.lastPathComponent
            let presign = try await VOPIClient.shared.getPresignedURL(
                filename: filename,
                contentType: "video/mp4"
            )

            // Step 2: Upload to S3
            currentStep = "Uploading video..."
            try await VOPIClient.shared.uploadToS3(
                url: URL(string: presign.uploadUrl)!,
                fileURL: videoURL,
                contentType: "video/mp4"
            ) { [weak self] progress in
                self?.uploadProgress = progress
            }

            isUploading = false
            isProcessing = true

            // Step 3: Create job
            currentStep = "Starting processing..."
            let job = try await VOPIClient.shared.createJob(
                videoUrl: presign.publicUrl,
                config: config
            )

            currentJobId = job.id

            // Step 4: Poll for completion
            await pollJobStatus(jobId: job.id)

        } catch {
            self.error = error
            isUploading = false
            isProcessing = false
        }
    }

    // MARK: - Polling

    private func pollJobStatus(jobId: String) async {
        pollingTask?.cancel()

        pollingTask = Task {
            while !Task.isCancelled {
                do {
                    let status = try await VOPIClient.shared.getJobStatus(id: jobId)

                    await MainActor.run {
                        self.processingProgress = status.progress?.percentage ?? 0
                        self.currentStep = status.progress?.message ?? status.status.rawValue.capitalized
                    }

                    switch status.status {
                    case .completed:
                        await fetchResults(jobId: jobId)
                        return

                    case .failed, .cancelled:
                        await MainActor.run {
                            self.error = VOPIError.httpError(
                                statusCode: 400,
                                message: "Job \(status.status.rawValue)"
                            )
                            self.isProcessing = false
                        }
                        return

                    default:
                        try await Task.sleep(nanoseconds: UInt64(VOPIConfig.pollingInterval * 1_000_000_000))
                    }
                } catch {
                    if !Task.isCancelled {
                        await MainActor.run {
                            self.error = error
                            self.isProcessing = false
                        }
                    }
                    return
                }
            }
        }
    }

    private func fetchResults(jobId: String) async {
        do {
            let job = try await VOPIClient.shared.getJob(id: jobId)
            // Use presigned download URLs (required for private S3 bucket)
            let downloadUrls = try await VOPIClient.shared.getDownloadUrls(jobId: jobId)

            await MainActor.run {
                self.completedJob = job
                self.groupedImages = downloadUrls.commercialImages
                self.isProcessing = false
                self.currentStep = "Completed!"
            }
        } catch {
            await MainActor.run {
                self.error = error
                self.isProcessing = false
            }
        }
    }

    // MARK: - Cancel

    func cancelCurrentJob() async {
        pollingTask?.cancel()

        guard let jobId = currentJobId else { return }

        do {
            _ = try await VOPIClient.shared.cancelJob(id: jobId)
            isProcessing = false
            currentStep = "Cancelled"
        } catch {
            self.error = error
        }
    }
}
```

## Job Management

### Job List View Model

```swift
// JobListViewModel.swift
import Foundation

@MainActor
class JobListViewModel: ObservableObject {
    @Published var jobs: [Job] = []
    @Published var isLoading = false
    @Published var error: Error?

    private var currentPage = 0
    private let pageSize = 20

    func loadJobs(status: JobStatusType? = nil) async {
        isLoading = true
        error = nil

        do {
            let result: JobListResponse = try await VOPIClient.shared.request(
                path: "/api/v1/jobs",
                method: "GET"
            )

            jobs = result.jobs
        } catch {
            self.error = error
        }

        isLoading = false
    }

    func refreshJobs() async {
        currentPage = 0
        await loadJobs()
    }
}

struct JobListResponse: Decodable {
    let jobs: [Job]
    let total: Int
}
```

## Complete Example

### SwiftUI Integration

```swift
// ContentView.swift
import SwiftUI
import PhotosUI

struct ContentView: View {
    @StateObject private var uploadManager = VideoUploadManager()
    @State private var selectedItem: PhotosPickerItem?
    @State private var showingResults = false

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                // Video Picker
                PhotosPicker(
                    selection: $selectedItem,
                    matching: .videos
                ) {
                    Label("Select Video", systemImage: "video.badge.plus")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                }
                .disabled(uploadManager.isUploading || uploadManager.isProcessing)
                .onChange(of: selectedItem) { newItem in
                    Task {
                        if let item = newItem,
                           let url = try? await loadVideoURL(from: item) {
                            await uploadManager.uploadAndProcess(videoURL: url)
                        }
                    }
                }

                // Progress Section
                if uploadManager.isUploading || uploadManager.isProcessing {
                    VStack(spacing: 16) {
                        Text(uploadManager.currentStep)
                            .font(.subheadline)
                            .foregroundColor(.secondary)

                        if uploadManager.isUploading {
                            ProgressView(value: uploadManager.uploadProgress) {
                                Text("Uploading: \(Int(uploadManager.uploadProgress * 100))%")
                            }
                        } else {
                            ProgressView(value: Double(uploadManager.processingProgress) / 100) {
                                Text("Processing: \(uploadManager.processingProgress)%")
                            }
                        }

                        Button("Cancel", role: .destructive) {
                            Task {
                                await uploadManager.cancelCurrentJob()
                            }
                        }
                    }
                    .padding()
                    .background(Color(.systemGray6))
                    .cornerRadius(12)
                }

                // Error Display
                if let error = uploadManager.error {
                    Text(error.localizedDescription)
                        .foregroundColor(.red)
                        .font(.caption)
                }

                // Results Button
                if uploadManager.completedJob != nil {
                    Button("View Results") {
                        showingResults = true
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.green)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("VOPI")
            .sheet(isPresented: $showingResults) {
                ResultsView(
                    job: uploadManager.completedJob,
                    groupedImages: uploadManager.groupedImages
                )
            }
        }
    }

    private func loadVideoURL(from item: PhotosPickerItem) async throws -> URL? {
        guard let movie = try await item.loadTransferable(type: VideoTransferable.self) else {
            return nil
        }
        return movie.url
    }
}

// Video Transferable for PhotosPicker
struct VideoTransferable: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension("mp4")
            try FileManager.default.copyItem(at: received.file, to: tempURL)
            return Self(url: tempURL)
        }
    }
}

// Results View
// Note: groupedImages contains presigned URLs from getDownloadUrls()
// These URLs are time-limited (default: 1 hour) and include authentication tokens
struct ResultsView: View {
    let job: Job?
    let groupedImages: [String: [String: String]]  // Presigned URLs from download-urls endpoint

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            ScrollView {
                LazyVStack(spacing: 24) {
                    ForEach(Array(groupedImages.keys.sorted()), id: \.self) { variant in
                        VStack(alignment: .leading, spacing: 12) {
                            Text(variant.capitalized)
                                .font(.headline)

                            LazyVGrid(columns: [
                                GridItem(.flexible()),
                                GridItem(.flexible())
                            ], spacing: 8) {
                                ForEach(["transparent", "solid", "real", "creative"], id: \.self) { version in
                                    if let urlString = groupedImages[variant]?[version],
                                       let url = URL(string: urlString) {
                                        AsyncImage(url: url) { image in
                                            image
                                                .resizable()
                                                .aspectRatio(contentMode: .fit)
                                        } placeholder: {
                                            ProgressView()
                                        }
                                        .frame(height: 150)
                                        .background(Color(.systemGray6))
                                        .cornerRadius(8)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Results")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}
```

## Handling Background Uploads

For long uploads, support background URL sessions:

```swift
// BackgroundUploadManager.swift
import Foundation

class BackgroundUploadManager: NSObject {
    static let shared = BackgroundUploadManager()

    private lazy var backgroundSession: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "com.yourapp.vopi.upload")
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    var completionHandler: (() -> Void)?

    func uploadInBackground(url: URL, fileURL: URL, contentType: String) -> URLSessionUploadTask {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")

        let task = backgroundSession.uploadTask(with: request, fromFile: fileURL)
        task.resume()
        return task
    }
}

extension BackgroundUploadManager: URLSessionDelegate, URLSessionTaskDelegate {
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.completionHandler?()
            self.completionHandler = nil
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error = error {
            print("Background upload failed: \(error)")
        } else {
            print("Background upload completed")
            // Post notification or update state
        }
    }
}
```

Add to AppDelegate:

```swift
func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
) {
    BackgroundUploadManager.shared.completionHandler = completionHandler
}
```
