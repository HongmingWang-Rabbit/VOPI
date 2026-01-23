# Android/Kotlin Integration Guide

Complete guide for integrating VOPI into Android applications using Kotlin, Retrofit, and Coroutines.

> **Important: Private S3 Bucket**
>
> The VOPI S3 bucket is private. Direct URLs in job results are not publicly accessible. You must use the `/jobs/:id/download-urls` endpoint to get presigned URLs with temporary access tokens. These URLs expire after a configurable time (default: 1 hour).

## Table of Contents

- [Setup](#setup)
- [Dependencies](#dependencies)
- [API Client](#api-client)
- [Models](#models)
- [Video Upload](#video-upload)
- [Job Management](#job-management)
- [Complete Example](#complete-example)

## Setup

### Requirements

- Android API 24+ (Android 7.0)
- Kotlin 1.9+
- Android Studio Hedgehog or later

### Dependencies

Add to your `build.gradle.kts` (app module):

```kotlin
dependencies {
    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // ViewModel
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")

    // Image Loading
    implementation("io.coil-kt:coil-compose:2.5.0")

    // Compose (if using Jetpack Compose)
    implementation("androidx.compose.material3:material3:1.1.2")
    implementation("androidx.activity:activity-compose:1.8.2")
}
```

Add internet permission in `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
```

## API Client

### Configuration

```kotlin
// VOPIConfig.kt
object VOPIConfig {
    const val BASE_URL = "https://api.your-domain.com/"
    const val API_KEY = "your-api-key"

    const val UPLOAD_TIMEOUT_SECONDS = 300L // 5 minutes
    const val REQUEST_TIMEOUT_SECONDS = 30L
    const val POLLING_INTERVAL_MS = 3000L
}
```

### Retrofit Service

```kotlin
// VOPIService.kt
import retrofit2.Response
import retrofit2.http.*

interface VOPIService {

    // Presign upload URL
    @POST("api/v1/uploads/presign")
    suspend fun getPresignedUrl(
        @Body request: PresignRequest
    ): Response<PresignResponse>

    // Create job
    @POST("api/v1/jobs")
    suspend fun createJob(
        @Body request: CreateJobRequest
    ): Response<Job>

    // Get job details
    @GET("api/v1/jobs/{id}")
    suspend fun getJob(
        @Path("id") jobId: String
    ): Response<Job>

    // Get job status (lightweight)
    @GET("api/v1/jobs/{id}/status")
    suspend fun getJobStatus(
        @Path("id") jobId: String
    ): Response<JobStatus>

    // Cancel job
    @DELETE("api/v1/jobs/{id}")
    suspend fun cancelJob(
        @Path("id") jobId: String
    ): Response<CancelJobResponse>

    // Get grouped images
    @GET("api/v1/jobs/{id}/images/grouped")
    suspend fun getGroupedImages(
        @Path("id") jobId: String
    ): Response<Map<String, Map<String, String>>>

    // Get presigned download URLs (required for private S3 bucket)
    @GET("api/v1/jobs/{id}/download-urls")
    suspend fun getDownloadUrls(
        @Path("id") jobId: String,
        @Query("expiresIn") expiresIn: Int = 3600
    ): Response<DownloadUrlsResponse>

    // Get final frames
    @GET("api/v1/jobs/{id}/frames/final")
    suspend fun getFinalFrames(
        @Path("id") jobId: String
    ): Response<List<Frame>>

    // List jobs
    @GET("api/v1/jobs")
    suspend fun listJobs(
        @Query("status") status: String? = null,
        @Query("limit") limit: Int = 20,
        @Query("offset") offset: Int = 0
    ): Response<JobListResponse>
}
```

### API Client Setup

```kotlin
// VOPIClient.kt
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object VOPIClient {

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BODY
    }

    private val authInterceptor = okhttp3.Interceptor { chain ->
        val request = chain.request().newBuilder()
            .addHeader("x-api-key", VOPIConfig.API_KEY)
            .addHeader("Content-Type", "application/json")
            .build()
        chain.proceed(request)
    }

    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .addInterceptor(loggingInterceptor)
        .connectTimeout(VOPIConfig.REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(VOPIConfig.REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(VOPIConfig.UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val retrofit = Retrofit.Builder()
        .baseUrl(VOPIConfig.BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val service: VOPIService = retrofit.create(VOPIService::class.java)

    // Separate client for S3 uploads (no auth header)
    val s3Client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(VOPIConfig.UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(VOPIConfig.UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()
}
```

## Models

### Data Classes

```kotlin
// VOPIModels.kt
import com.google.gson.annotations.SerializedName

// Presign
data class PresignRequest(
    val filename: String? = null,
    val contentType: String = "video/mp4",
    val expiresIn: Int = 3600
)

data class PresignResponse(
    val uploadUrl: String,
    val key: String,
    val publicUrl: String,
    val expiresIn: Int
)

// Job
data class CreateJobRequest(
    val videoUrl: String,
    val config: JobConfig? = null,
    val callbackUrl: String? = null
)

data class JobConfig(
    val fps: Int = 10,
    val batchSize: Int = 30,
    val commercialVersions: List<CommercialVersion> = CommercialVersion.entries,
    val aiCleanup: Boolean = true,
    val geminiModel: String = "gemini-2.0-flash"
)

enum class CommercialVersion {
    @SerializedName("transparent") TRANSPARENT,
    @SerializedName("solid") SOLID,
    @SerializedName("real") REAL,
    @SerializedName("creative") CREATIVE
}

data class Job(
    val id: String,
    val status: JobStatusType,
    val videoUrl: String,
    val config: JobConfig?,
    val progress: JobProgress?,
    val result: JobResult?,
    val error: String?,
    val createdAt: String,
    val updatedAt: String?,
    val startedAt: String?,
    val completedAt: String?
)

enum class JobStatusType {
    @SerializedName("pending") PENDING,
    @SerializedName("downloading") DOWNLOADING,
    @SerializedName("extracting") EXTRACTING,
    @SerializedName("scoring") SCORING,
    @SerializedName("classifying") CLASSIFYING,
    @SerializedName("extracting_product") EXTRACTING_PRODUCT,
    @SerializedName("generating") GENERATING,
    @SerializedName("completed") COMPLETED,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED
}

data class JobProgress(
    val step: String,
    val percentage: Int,
    val message: String?,
    val totalSteps: Int?,
    val currentStep: Int?
)

data class JobStatus(
    val id: String,
    val status: JobStatusType,
    val progress: JobProgress?,
    val createdAt: String,
    val updatedAt: String?
)

data class JobResult(
    val variantsDiscovered: Int?,
    val framesAnalyzed: Int?,
    val finalFrames: List<String>?,
    val commercialImages: Map<String, Map<String, String>>?
)

data class CancelJobResponse(
    val id: String,
    val status: JobStatusType,
    val message: String
)

// Download URLs (for private S3 bucket)
data class DownloadUrlsResponse(
    val jobId: String,
    val expiresIn: Int,
    val frames: List<FrameDownload>,
    val commercialImages: Map<String, Map<String, String>>,
    /** Product metadata extracted from audio analysis (null if no audio or analysis failed) */
    val productMetadata: ProductMetadataOutput?
)

data class FrameDownload(
    val frameId: String,
    val downloadUrl: String
)

// Product Metadata (from audio analysis)

/** Complete product metadata output including platform-specific formats */
data class ProductMetadataOutput(
    /** Raw transcript from audio */
    val transcript: String,
    /** Universal product metadata */
    val product: ProductMetadata,
    /** Platform-specific formatted versions */
    val platforms: PlatformFormats,
    /** ISO timestamp when metadata was extracted */
    val extractedAt: String,
    /** Audio duration in seconds (if available) */
    val audioDuration: Double?,
    /** Pipeline version */
    val pipelineVersion: String
)

/** Universal product metadata */
data class ProductMetadata(
    val title: String,
    val description: String,
    val shortDescription: String?,
    val bulletPoints: List<String>,
    val brand: String?,
    val category: String?,
    val subcategory: String?,
    val materials: List<String>?,
    val color: String?,
    val colors: List<String>?,
    val size: String?,
    val sizes: List<String>?,
    val price: Double?,
    val currency: String?,
    val keywords: List<String>?,
    val tags: List<String>?,
    val condition: String?,
    val confidence: MetadataConfidence,
    val extractedFromAudio: Boolean,
    val transcriptExcerpts: List<String>?
)

/** Confidence scores for metadata fields */
data class MetadataConfidence(
    val overall: Int,
    val title: Int,
    val description: Int,
    val price: Int?,
    val attributes: Int?
)

/** Platform-specific formatted product data */
data class PlatformFormats(
    val shopify: ShopifyProduct,
    val amazon: AmazonProduct,
    val ebay: EbayProduct
)

/** Shopify-formatted product data */
data class ShopifyProduct(
    val title: String,
    val descriptionHtml: String,
    val productType: String?,
    val vendor: String?,
    val tags: List<String>?,
    val status: String?
)

/** Amazon-formatted product data */
data class AmazonProduct(
    @SerializedName("item_name") val itemName: String,
    @SerializedName("brand_name") val brandName: String?,
    @SerializedName("product_description") val productDescription: String?,
    @SerializedName("bullet_point") val bulletPoint: List<String>?,
    @SerializedName("generic_keyword") val genericKeyword: List<String>?,
    val color: String?,
    val material: List<String>?
)

/** eBay-formatted product data */
data class EbayProduct(
    val title: String,
    val description: String,
    val condition: String,
    val conditionDescription: String?,
    val brand: String?,
    val aspects: Map<String, List<String>>?
)

data class JobListResponse(
    val jobs: List<Job>,
    val total: Int
)

// Frame
data class Frame(
    val id: String,
    val jobId: String,
    val frameId: String,
    val timestamp: Double,
    val s3Url: String,
    val productId: String?,
    val variantId: String?,
    val angleEstimate: String?,
    val variantDescription: String?,
    val obstructions: FrameObstructions?,
    val backgroundRecommendations: BackgroundRecommendations?,
    val createdAt: String
)

data class FrameObstructions(
    @SerializedName("has_obstruction") val hasObstruction: Boolean,
    @SerializedName("obstruction_types") val obstructionTypes: List<String>?,
    @SerializedName("obstruction_description") val obstructionDescription: String?,
    @SerializedName("removable_by_ai") val removableByAi: Boolean?
)

data class BackgroundRecommendations(
    @SerializedName("solid_color") val solidColor: String?,
    @SerializedName("solid_color_name") val solidColorName: String?,
    @SerializedName("real_life_setting") val realLifeSetting: String?,
    @SerializedName("creative_shot") val creativeShot: String?
)

// Error
data class ApiError(
    val error: String,
    val statusCode: Int,
    val details: Map<String, String>?
)
```

## Video Upload

### Upload Repository

```kotlin
// VOPIRepository.kt
import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.InputStream

sealed class UploadState {
    data object Idle : UploadState()
    data class Uploading(val progress: Float) : UploadState()
    data class Processing(val progress: Int, val step: String) : UploadState()
    data class Completed(val job: Job, val images: Map<String, Map<String, String>>) : UploadState()
    data class Error(val message: String) : UploadState()
    data object Cancelled : UploadState()
}

class VOPIRepository(private val context: Context) {

    private val service = VOPIClient.service
    private var currentJobId: String? = null

    // Full upload and process flow
    fun uploadAndProcess(
        videoUri: Uri,
        config: JobConfig = JobConfig()
    ): Flow<UploadState> = flow {
        emit(UploadState.Idle)

        try {
            // Step 1: Get presigned URL
            val filename = getFileName(videoUri) ?: "video.mp4"
            val presignResponse = service.getPresignedUrl(
                PresignRequest(filename = filename)
            )

            if (!presignResponse.isSuccessful) {
                emit(UploadState.Error("Failed to get upload URL"))
                return@flow
            }

            val presign = presignResponse.body()!!

            // Step 2: Upload to S3 with progress
            val inputStream = context.contentResolver.openInputStream(videoUri)
                ?: throw Exception("Cannot open video file")

            val fileSize = getFileSize(videoUri)

            uploadToS3(presign.uploadUrl, inputStream, fileSize) { progress ->
                // This is called from a background thread
            }.collect { progress ->
                emit(UploadState.Uploading(progress))
            }

            // Step 3: Create job
            val jobResponse = service.createJob(
                CreateJobRequest(
                    videoUrl = presign.publicUrl,
                    config = config
                )
            )

            if (!jobResponse.isSuccessful) {
                emit(UploadState.Error("Failed to create job"))
                return@flow
            }

            val job = jobResponse.body()!!
            currentJobId = job.id

            // Step 4: Poll for completion
            while (true) {
                delay(VOPIConfig.POLLING_INTERVAL_MS)

                val statusResponse = service.getJobStatus(job.id)
                if (!statusResponse.isSuccessful) continue

                val status = statusResponse.body()!!
                emit(UploadState.Processing(
                    progress = status.progress?.percentage ?: 0,
                    step = status.progress?.message ?: status.status.name.lowercase().replaceFirstChar { it.uppercase() }
                ))

                when (status.status) {
                    JobStatusType.COMPLETED -> {
                        val fullJob = service.getJob(job.id).body()!!
                        // Use presigned download URLs (required for private S3 bucket)
                        val downloadUrls = service.getDownloadUrls(job.id).body()
                        val images = downloadUrls?.commercialImages ?: emptyMap()
                        emit(UploadState.Completed(fullJob, images))
                        return@flow
                    }
                    JobStatusType.FAILED, JobStatusType.CANCELLED -> {
                        emit(UploadState.Error("Job ${status.status.name.lowercase()}"))
                        return@flow
                    }
                    else -> continue
                }
            }
        } catch (e: Exception) {
            emit(UploadState.Error(e.message ?: "Unknown error"))
        }
    }

    private fun uploadToS3(
        url: String,
        inputStream: InputStream,
        fileSize: Long
    ): Flow<Float> = flow {
        withContext(Dispatchers.IO) {
            var bytesUploaded = 0L

            val requestBody = object : RequestBody() {
                override fun contentType() = "video/mp4".toMediaType()
                override fun contentLength() = fileSize

                override fun writeTo(sink: BufferedSink) {
                    inputStream.source().use { source ->
                        val buffer = okio.Buffer()
                        var read: Long

                        while (source.read(buffer, 8192).also { read = it } != -1L) {
                            sink.write(buffer, read)
                            bytesUploaded += read
                        }
                    }
                }
            }

            val request = Request.Builder()
                .url(url)
                .put(requestBody)
                .addHeader("Content-Type", "video/mp4")
                .build()

            VOPIClient.s3Client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw Exception("Upload failed: ${response.code}")
                }
            }
        }

        emit(1f) // Complete
    }

    suspend fun cancelCurrentJob(): Boolean {
        val jobId = currentJobId ?: return false
        return try {
            val response = service.cancelJob(jobId)
            response.isSuccessful
        } catch (e: Exception) {
            false
        }
    }

    private fun getFileName(uri: Uri): String? {
        return context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            cursor.moveToFirst()
            cursor.getString(nameIndex)
        }
    }

    private fun getFileSize(uri: Uri): Long {
        return context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
            cursor.moveToFirst()
            cursor.getLong(sizeIndex)
        } ?: 0L
    }
}
```

## Job Management

### ViewModel

```kotlin
// VOPIViewModel.kt
import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class VOPIViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = VOPIRepository(application)

    private val _uploadState = MutableStateFlow<UploadState>(UploadState.Idle)
    val uploadState: StateFlow<UploadState> = _uploadState.asStateFlow()

    private val _jobs = MutableStateFlow<List<Job>>(emptyList())
    val jobs: StateFlow<List<Job>> = _jobs.asStateFlow()

    fun uploadVideo(uri: Uri, config: JobConfig = JobConfig()) {
        viewModelScope.launch {
            repository.uploadAndProcess(uri, config).collect { state ->
                _uploadState.value = state
            }
        }
    }

    fun cancelUpload() {
        viewModelScope.launch {
            repository.cancelCurrentJob()
            _uploadState.value = UploadState.Cancelled
        }
    }

    fun loadJobs() {
        viewModelScope.launch {
            try {
                val response = VOPIClient.service.listJobs()
                if (response.isSuccessful) {
                    _jobs.value = response.body()?.jobs ?: emptyList()
                }
            } catch (e: Exception) {
                // Handle error
            }
        }
    }

    fun resetState() {
        _uploadState.value = UploadState.Idle
    }
}
```

## Complete Example

### Jetpack Compose UI

```kotlin
// MainActivity.kt
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    VOPIScreen()
                }
            }
        }
    }
}

@Composable
fun VOPIScreen(viewModel: VOPIViewModel = viewModel()) {
    val uploadState by viewModel.uploadState.collectAsState()
    var showResults by remember { mutableStateOf(false) }

    val videoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        uri?.let { viewModel.uploadVideo(it) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "VOPI",
            style = MaterialTheme.typography.headlineLarge
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Video Picker Button
        Button(
            onClick = {
                videoPicker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly)
                )
            },
            enabled = uploadState is UploadState.Idle || uploadState is UploadState.Completed || uploadState is UploadState.Error,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Select Video")
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Status Display
        when (val state = uploadState) {
            is UploadState.Idle -> {
                Text("Select a video to start processing")
            }

            is UploadState.Uploading -> {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("Uploading video...")
                    Spacer(modifier = Modifier.height(8.dp))
                    LinearProgressIndicator(
                        progress = { state.progress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("${(state.progress * 100).toInt()}%")

                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedButton(onClick = { viewModel.cancelUpload() }) {
                        Text("Cancel")
                    }
                }
            }

            is UploadState.Processing -> {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(state.step)
                    Spacer(modifier = Modifier.height(8.dp))
                    LinearProgressIndicator(
                        progress = { state.progress / 100f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("${state.progress}%")

                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedButton(onClick = { viewModel.cancelUpload() }) {
                        Text("Cancel")
                    }
                }
            }

            is UploadState.Completed -> {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        "Processing Complete!",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.primary
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = { showResults = true },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("View Results")
                    }

                    OutlinedButton(
                        onClick = { viewModel.resetState() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Process Another Video")
                    }
                }
            }

            is UploadState.Error -> {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        "Error: ${state.message}",
                        color = MaterialTheme.colorScheme.error
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = { viewModel.resetState() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Try Again")
                    }
                }
            }

            is UploadState.Cancelled -> {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("Upload cancelled")

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = { viewModel.resetState() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Start Over")
                    }
                }
            }
        }
    }

    // Results Bottom Sheet
    if (showResults && uploadState is UploadState.Completed) {
        ResultsBottomSheet(
            images = (uploadState as UploadState.Completed).images,
            onDismiss = { showResults = false }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResultsBottomSheet(
    images: Map<String, Map<String, String>>,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Text(
                "Results",
                style = MaterialTheme.typography.headlineSmall
            )

            Spacer(modifier = Modifier.height(16.dp))

            LazyColumn {
                images.forEach { (variant, versions) ->
                    item {
                        Text(
                            variant.replaceFirstChar { it.uppercase() },
                            style = MaterialTheme.typography.titleMedium
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                    }

                    item {
                        LazyVerticalGrid(
                            columns = GridCells.Fixed(2),
                            modifier = Modifier.height(300.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            items(versions.entries.toList()) { (version, url) ->
                                Card {
                                    Column {
                                        AsyncImage(
                                            model = url,
                                            contentDescription = "$variant - $version",
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .height(120.dp),
                                            contentScale = ContentScale.Crop
                                        )
                                        Text(
                                            version.replaceFirstChar { it.uppercase() },
                                            modifier = Modifier.padding(8.dp),
                                            style = MaterialTheme.typography.labelSmall
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item {
                        Spacer(modifier = Modifier.height(24.dp))
                    }
                }
            }
        }
    }
}
```

## WorkManager for Background Uploads

For reliable background uploads, use WorkManager:

```kotlin
// VideoUploadWorker.kt
import android.content.Context
import android.net.Uri
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class VideoUploadWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val videoUriString = inputData.getString("video_uri") ?: return@withContext Result.failure()
        val videoUri = Uri.parse(videoUriString)

        try {
            val repository = VOPIRepository(applicationContext)

            // Get presigned URL
            val presignResponse = VOPIClient.service.getPresignedUrl(
                PresignRequest(filename = "video.mp4")
            )

            if (!presignResponse.isSuccessful) {
                return@withContext Result.retry()
            }

            val presign = presignResponse.body()!!

            // Upload to S3
            applicationContext.contentResolver.openInputStream(videoUri)?.use { inputStream ->
                // ... upload logic
            }

            // Create job
            val jobResponse = VOPIClient.service.createJob(
                CreateJobRequest(videoUrl = presign.publicUrl)
            )

            if (jobResponse.isSuccessful) {
                val outputData = workDataOf(
                    "job_id" to jobResponse.body()!!.id
                )
                Result.success(outputData)
            } else {
                Result.retry()
            }
        } catch (e: Exception) {
            if (runAttemptCount < 3) {
                Result.retry()
            } else {
                Result.failure()
            }
        }
    }

    companion object {
        fun enqueue(context: Context, videoUri: Uri): Operation {
            val inputData = workDataOf("video_uri" to videoUri.toString())

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = OneTimeWorkRequestBuilder<VideoUploadWorker>()
                .setInputData(inputData)
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    java.util.concurrent.TimeUnit.MILLISECONDS
                )
                .build()

            return WorkManager.getInstance(context).enqueue(request)
        }
    }
}
```
